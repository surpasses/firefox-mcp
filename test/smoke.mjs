// Smoke test: boots a throwaway headless Firefox on its own profile and port, serves
// two tiny pages on two origins (127.0.0.1 and localhost, so the iframe is
// cross-origin), and exercises the Firefox class end to end.
//   node test/smoke.mjs            (keeps your real Firefox untouched)

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Firefox, sleep } from "../src/browser.mjs";

const PORT = 9333;
const FIREFOX = process.env.FIREFOX_BIN ?? "/Applications/Firefox.app/Contents/MacOS/firefox";

const PARENT = (childOrigin) => `<!doctype html><title>fxmcp parent</title>
<h1 id="h">Parent page</h1>
<p>Some text about volleyball.</p>
<label>Name <input id="name" placeholder="Your name"></label>
<label>Size <select id="size"><option>S</option><option>M</option><option>L</option></select></label>
<label><input type="checkbox" id="agree"> I agree</label>
<button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('name').value; console.log('go clicked'); fetch('/api/ping')">Go</button>
<span id="out"></span>
<div style="height:1500px"></div>
<a id="bottom" href="#top">Bottom link</a>
<iframe id="card" src="${childOrigin}/child" style="width:400px;height:120px;border:2px solid red"></iframe>
<script>console.error("boom from parent")</script>`;

const CHILD = `<!doctype html><title>child</title>
<label>Card number <input id="cc" inputmode="numeric" placeholder="1234 1234 1234 1234"></label>
<button id="pay" onclick="document.getElementById('res').textContent='paid:'+document.getElementById('cc').value">Pay</button>
<span id="res"></span>`;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

async function serve() {
  const srv = createServer((req, res) => {
    if (req.url === "/api/ping") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    const childOrigin = `http://localhost:${srv.address().port}`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url.startsWith("/child") ? CHILD : PARENT(childOrigin));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

const profile = await mkdtemp(path.join(tmpdir(), "fxmcp-smoke-"));
await writeFile(path.join(profile, "user.js"), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
  'user_pref("browser.sessionstore.resume_from_crash", false);',
].join("\n"));

const srv = await serve();
const base = `http://127.0.0.1:${srv.address().port}`;
const proc = spawn(FIREFOX, ["-headless", "--no-remote", "--new-instance", "-profile", profile, "--remote-debugging-port", String(PORT), "about:blank"], { stdio: "ignore" });

try {
  const ff = new Firefox({ port: PORT });
  let connected = false;
  for (let i = 0; i < 60 && !connected; i++) {
    try { await ff.ensure(); connected = true; } catch { await sleep(500); }
  }
  check("connect to BiDi", connected, ff.client?.browser ? `${ff.client.browser.browserName} ${ff.client.browser.browserVersion}` : "");
  if (!connected) throw new Error("could not connect");

  const before = await ff.tabs();
  check("tabs_context lists existing tab", before.length >= 1, JSON.stringify(before.map((t) => [t.tabId, t.url])));

  const { tabId } = await ff.createTab(`${base}/`);
  const info = await ff.info(tabId);
  check("create tab + navigate", info.url === `${base}/` && info.title === "fxmcp parent", JSON.stringify(info));

  await ff.setViewport(tabId, 1000, 700);
  const snap = await ff.snapshot(tabId, "interactive");
  const top = snap[0];
  check("snapshot has frames", snap.length === 2, `frames=${snap.map((s) => s.frame.key + ":" + s.frame.url).join(", ")}`);
  const nameItem = top.items.find((i) => i.id === "name");
  const btn = top.items.find((i) => i.id === "go");
  check("snapshot finds input with label name", nameItem?.name === "Name", JSON.stringify(nameItem));
  check("snapshot finds button", btn?.role === "button" && btn.name === "Go", JSON.stringify(btn));

  await ff.setValue(tabId, nameItem.ref, "Kev");
  await ff.setValue(tabId, top.items.find((i) => i.id === "size").ref, "L");
  await ff.setValue(tabId, top.items.find((i) => i.id === "agree").ref, true);
  const vals = await ff.evaluate(tabId, "[document.getElementById('name').value, document.getElementById('size').value, document.getElementById('agree').checked]");
  check("form_input text/select/checkbox", JSON.stringify(vals) === JSON.stringify(["Kev", "L", true]), JSON.stringify(vals));

  const p = await ff.locate(tabId, nameItem.ref);
  await ff.click(tabId, { x: p.x, y: p.y });
  await ff.pressKeys(tabId, "cmd+a Backspace");
  await ff.typeText(tabId, "Typed ✓");
  const typed = await ff.evaluate(tabId, "document.getElementById('name').value");
  check("click + select-all + type (unicode)", typed === "Typed ✓", JSON.stringify(typed));

  const b = await ff.locate(tabId, btn.ref);
  await ff.click(tabId, { x: b.x, y: b.y });
  await sleep(300);
  const out = await ff.evaluate(tabId, "document.getElementById('out').textContent");
  check("click button runs handler", out === "clicked:Typed ✓", JSON.stringify(out));

  const found = await ff.find(tabId, "bottom link");
  check("find by text", found[0]?.items[0]?.id === "bottom", JSON.stringify(found[0]?.items[0]));
  const loc = await ff.locate(tabId, found[0].items[0].ref);
  const afterScroll = await ff.info(tabId);
  check("locate scrolls offscreen element into view", afterScroll.scrollY > 500 && loc.y > 0 && loc.y < 700, JSON.stringify({ loc, scrollY: afterScroll.scrollY }));

  // Cross-origin iframe: type a card number into the child frame by ref, click Pay.
  const snap2 = await ff.snapshot(tabId, "interactive");
  const child = snap2.find((s) => s.frame.key === "f1");
  const cc = child?.items.find((i) => i.id === "cc");
  check("iframe (cross-origin) elements listed", !!cc && child.frame.url.includes("localhost"), JSON.stringify({ url: child?.frame.url, cc }));
  const pcc = await ff.locate(tabId, `f1:${cc.ref}`);
  await ff.click(tabId, { x: pcc.x, y: pcc.y });
  await ff.typeText(tabId, "4242424242424242");
  const pay = child.items.find((i) => i.id === "pay");
  const ppay = await ff.locate(tabId, `f1:${pay.ref}`);
  await ff.click(tabId, { x: ppay.x, y: ppay.y });
  await sleep(300);
  const paid = await ff.evaluate(tabId, "document.getElementById('res').textContent", "f1");
  check("type + click inside cross-origin iframe via top-level coordinates", paid === "paid:4242424242424242", JSON.stringify(paid));

  const png = await ff.screenshot(tabId);
  check("screenshot returns PNG", png.length > 1000 && Buffer.from(png, "base64").subarray(1, 4).toString() === "PNG", `${png.length} b64 chars`);
  const clip = await ff.screenshot(tabId, { x: 0, y: 0, width: 200, height: 100 });
  check("clipped screenshot smaller", clip.length < png.length);

  const txt = await ff.pageText(tabId);
  check("page text includes parent and frame", txt.includes("volleyball") && txt.includes("Card number"), `${txt.length} chars`);

  await sleep(500);
  const cons = await ff.consoleEntries(tabId);
  check("console captured error + log", cons.some((e) => /boom from parent/.test(e.text) && e.level === "error") && cons.some((e) => /go clicked/.test(e.text)), JSON.stringify(cons.map((e) => [e.level, e.text])));
  const net = await ff.networkEntries(tabId, { pattern: "api/ping" });
  check("network captured fetch with status", net.length === 1 && net[0].status === 200 && /json/.test(net[0].mimeType), JSON.stringify(net));

  await ff.navigate(tabId, `${base}/child`);
  const back = await ff.navigate(tabId, "back");
  check("navigate back", back.url === `${base}/`, JSON.stringify(back));
  const tabsNow = await ff.tabs();
  await ff.closeTab(tabId);
  const tabsAfter = await ff.tabs();
  check("close tab", tabsAfter.length === tabsNow.length - 1, `${tabsNow.length} -> ${tabsAfter.length}`);

  ff.client.close();
} catch (e) {
  failures++;
  console.log("FAIL  exception:", e.stack ?? e);
} finally {
  proc.kill("SIGTERM");
  srv.close();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
