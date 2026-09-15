#!/usr/bin/env node
// firefox-mcp: an MCP server that drives a running Firefox over WebDriver BiDi.
// Firefox must be started with `--remote-debugging-port <port>` (see bin/firefox-debug).
// Never write to stdout here: it is the MCP transport. Log with console.error.

import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Firefox, sleep } from "./src/browser.mjs";

const PORT = Number(process.env.FIREFOX_MCP_PORT ?? 9222);
const HOST = process.env.FIREFOX_MCP_HOST ?? "127.0.0.1";
const ff = new Firefox({ host: HOST, port: PORT });

const server = new McpServer({ name: "firefox-mcp", version: "0.1.0" });

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 1) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${String(e?.message ?? e).replace(/^Error:\s*/, "")}` }], isError: true });
const tool = (name, description, shape, fn) =>
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      return fail(e);
    }
  });

const tabId = z.number().int().describe("Tab id from tabs_context");
const optTabId = z.number().int().optional().describe("Tab id from tabs_context; omit for all tabs");
const ref = z.string().describe("Element ref from read_page or find, e.g. ref_12 or f1:ref_3 (f1 = inside frame 1)");

function fmtItems(frames) {
  const lines = [];
  for (const f of frames) {
    if (f.frame.key !== "f0" || frames.length > 1) lines.push(`--- frame ${f.frame.key}: ${f.url ?? f.frame.url}${f.error ? ` (no access: ${f.error})` : ""}`);
    for (const it of f.items ?? []) {
      const r = f.frame.key === "f0" ? it.ref : `${f.frame.key}:${it.ref}`;
      const bits = [`${r} [${it.role}]`];
      if (it.level) bits.push(`h${it.level}`);
      if (it.name) bits.push(JSON.stringify(it.name));
      if (it.type && it.role !== it.type && it.tag === "input") bits.push(`type=${it.type}`);
      if (it.value !== undefined && it.value !== "") bits.push(`value=${JSON.stringify(it.value)}`);
      if (it.options) bits.push(`options=[${it.options.join(" | ")}]`);
      if (it.checked !== undefined) bits.push(it.checked ? "checked" : "unchecked");
      if (it.expanded !== undefined) bits.push(it.expanded ? "expanded" : "collapsed");
      if (it.disabled) bits.push("disabled");
      if (it.href) bits.push(`href=${it.href}`);
      if (it.src) bits.push(`src=${it.src}`);
      if (it.id) bits.push(`#${it.id}`);
      bits.push(`@(${it.x + f.frame.ox | 0},${it.y + f.frame.oy | 0}) ${it.w}x${it.h}${it.offscreen ? " offscreen" : ""}`);
      lines.push(bits.join(" "));
    }
    if (f.truncated) lines.push(`... truncated at ${f.items.length} items; use find or raise maxItems`);
  }
  return lines.join("\n");
}

async function locateOrPoint(id, args) {
  if (args.ref) {
    const p = await ff.locate(id, args.ref);
    return { x: p.x, y: p.y, target: p.target, label: `${args.ref} at (${p.x},${p.y})${p.frame.key !== "f0" ? ` in frame ${p.frame.key}` : ""}` };
  }
  if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y, label: `(${args.x},${args.y})` };
  throw new Error("Provide either ref or both x and y");
}

// ---- tabs --------------------------------------------------------------------

tool("tabs_context", "List Firefox tabs (id, url, title, active). Call this first; tab ids are stable while the server runs.", {}, async () => {
  const tabs = await ff.tabs();
  return text(tabs.map((t) => `${t.tabId}${t.active ? "*" : ""}\t${t.url}\t${t.title}`).join("\n") || "(no tabs)");
});

tool("tabs_create", "Open a new tab, optionally navigating to a URL. Returns its tab id.", { url: z.string().optional() }, async ({ url }) =>
  text(await ff.createTab(url)),
);

tool("tabs_close", "Close a tab.", { tabId }, async ({ tabId: id }) => {
  await ff.closeTab(id);
  return text(`closed tab ${id}`);
});

tool("tabs_activate", "Bring a tab to the front.", { tabId }, async ({ tabId: id }) => {
  await ff.activate(id);
  return text(`activated tab ${id}`);
});

tool("navigate", "Navigate a tab to a URL, or 'back' / 'forward'. Waits for the load event (45 s cap).", { tabId, url: z.string() }, async ({ tabId: id, url }) =>
  text(await ff.navigate(id, url)),
);

tool("resize_viewport", "Set the tab's viewport size in CSS pixels (e.g. 390x844 for phone).", { tabId, width: z.number().int(), height: z.number().int() }, async ({ tabId: id, width, height }) =>
  text(await ff.setViewport(id, width, height)),
);

// ---- looking -------------------------------------------------------------------

tool(
  "screenshot",
  "Screenshot the visible viewport as PNG. `region` [x0,y0,x1,y1] crops (zoom). `savePath` also writes the file.",
  { tabId, region: z.array(z.number()).length(4).optional(), savePath: z.string().optional() },
  async ({ tabId: id, region, savePath }) => {
    const clip = region ? { x: region[0], y: region[1], width: region[2] - region[0], height: region[3] - region[1] } : undefined;
    const data = await ff.screenshot(id, clip);
    if (savePath) await writeFile(savePath, Buffer.from(data, "base64"));
    const info = await ff.info(id);
    return {
      content: [
        { type: "text", text: `${info.url} viewport ${info.viewport}${clip ? ` clip ${JSON.stringify(clip)}` : ""}${savePath ? ` saved ${savePath}` : ""}. Coordinates for click/scroll are CSS px in this viewport.` },
        { type: "image", data, mimeType: "image/png" },
      ],
    };
  },
);

tool(
  "read_page",
  "List page elements with refs for click/type/form_input. filter=interactive (default) lists controls and links; filter=all adds headings and text. Crosses into iframes (refs prefixed fN:).",
  { tabId, filter: z.enum(["interactive", "all"]).optional(), maxItems: z.number().int().optional() },
  async ({ tabId: id, filter, maxItems }) => {
    const frames = await ff.snapshot(id, filter ?? "interactive", maxItems ?? 600);
    const top = frames[0];
    const head = `${top.url} | ${top.title ?? ""} | viewport ${top.vw}x${top.vh} scrollY ${top.scrollY}/${top.docHeight}`;
    return text(`${head}\n${fmtItems(frames)}`);
  },
);

tool(
  "find",
  "Find elements by text, label, placeholder, id, name or href (case-insensitive regex), or by CSS selector. Returns up to 20 refs per frame.",
  { tabId, query: z.string().describe("Regex or plain text matched against name/label/placeholder/id/href"), selector: z.string().optional().describe("CSS selector; when set, query is ignored") },
  async ({ tabId: id, query, selector }) => {
    const frames = await ff.find(id, query, selector);
    if (!frames.length) return text(`no matches for ${selector ? `selector ${selector}` : JSON.stringify(query)}`);
    return text(frames.map((f) => `${f.total} match(es)${f.frame.key !== "f0" ? ` in frame ${f.frame.key}` : ""}`).join("; ") + "\n" + fmtItems(frames));
  },
);

tool("get_page_text", "Visible text of the page (innerText), including frames. Up to ~80k chars per frame.", { tabId }, async ({ tabId: id }) => text(await ff.pageText(id)));

tool(
  "evaluate",
  "Evaluate a JavaScript expression in the page (top frame by default) and return its value. Use `frame` (e.g. f1) to target an iframe. Never trigger alert/confirm/prompt.",
  { tabId, expression: z.string(), frame: z.string().optional() },
  async ({ tabId: id, expression, frame }) => text(await ff.evaluate(id, expression, frame ?? "f0")),
);

// ---- acting --------------------------------------------------------------------

tool(
  "click",
  "Click an element by ref (scrolled into view first) or at viewport coordinates. count=2 double-clicks, count=3 triple-clicks (select paragraph). modifiers like 'shift' or 'cmd+shift'.",
  {
    tabId, ref: ref.optional(), x: z.number().optional(), y: z.number().optional(),
    button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional(), modifiers: z.string().optional(),
  },
  async (args) => {
    const p = await locateOrPoint(args.tabId, args);
    await ff.click(args.tabId, { x: p.x, y: p.y, target: p.target, button: args.button, count: args.count ?? 1, modifiers: args.modifiers });
    await sleep(150);
    return text(`clicked ${p.label}`);
  },
);

tool("hover", "Move the mouse over an element (by ref) or a point, to reveal menus and tooltips.", { tabId, ref: ref.optional(), x: z.number().optional(), y: z.number().optional() }, async (args) => {
  const p = await locateOrPoint(args.tabId, args);
  await ff.hover(args.tabId, p);
  return text(`hovering ${p.label}`);
});

tool(
  "drag",
  "Drag with the left mouse button from one point to another.",
  { tabId, fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number() },
  async ({ tabId: id, fromX, fromY, toX, toY }) => {
    await ff.drag(id, { x: fromX, y: fromY }, { x: toX, y: toY });
    return text(`dragged (${fromX},${fromY}) -> (${toX},${toY})`);
  },
);

tool(
  "type",
  "Type text with real key events into the focused element, or into `ref` (clicked first). clear=true selects all and deletes first. pressEnter=true submits.",
  { tabId, text: z.string(), ref: ref.optional(), clear: z.boolean().optional(), pressEnter: z.boolean().optional() },
  async ({ tabId: id, text: t, ref: r, clear, pressEnter }) => {
    let where = "focused element";
    let context;
    if (r) {
      const p = await ff.locate(id, r);
      await ff.click(id, { target: p.target });
      await sleep(100);
      where = r;
      context = p.target.context;
    }
    if (clear) await ff.pressKeys(id, process.platform === "darwin" ? "cmd+a Backspace" : "ctrl+a Backspace", 1, context);
    await ff.typeText(id, t, context);
    if (pressEnter) await ff.pressKeys(id, "Enter", 1, context);
    return text(`typed ${t.length} chars into ${where}${pressEnter ? " + Enter" : ""}`);
  },
);

tool(
  "press_key",
  "Press keys: 'Enter', 'Tab', 'Escape', 'ArrowDown', 'cmd+a', 'shift+Tab', or several space-separated ('Backspace Backspace Enter'). repeat repeats the whole sequence.",
  { tabId, keys: z.string(), repeat: z.number().int().min(1).max(100).optional() },
  async ({ tabId: id, keys, repeat }) => {
    await ff.pressKeys(id, keys, repeat ?? 1);
    return text(`pressed ${keys}${repeat > 1 ? ` x${repeat}` : ""}`);
  },
);

tool(
  "form_input",
  "Set a form control's value directly (fires input/change): text/textarea, select (option text or value), checkbox/radio (true/false), contenteditable. Prefer `type` for fields that validate on keystrokes (card numbers).",
  { tabId, ref, value: z.union([z.string(), z.boolean(), z.number()]) },
  async ({ tabId: id, ref: r, value }) => text(await ff.setValue(id, r, value)),
);

tool(
  "scroll",
  "Scroll with the mouse wheel at a point (default viewport centre) or over a ref. amount = wheel ticks of 100px.",
  { tabId, direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(50).optional(), ref: ref.optional(), x: z.number().optional(), y: z.number().optional() },
  async (args) => {
    let x = args.x, y = args.y, target;
    if (args.ref) ({ x, y, target } = await ff.locate(args.tabId, args.ref));
    if (x === undefined || y === undefined) {
      const frames = await ff.snapshot(args.tabId, "interactive", 1);
      x = Math.round(frames[0].vw / 2);
      y = Math.round(frames[0].vh / 2);
    }
    await ff.scroll(args.tabId, { x, y, target, direction: args.direction, amount: args.amount ?? 3 });
    await sleep(200);
    return text(`scrolled ${args.direction} ${args.amount ?? 3} ticks at (${x},${y}); ${JSON.stringify(await ff.info(args.tabId))}`);
  },
);

tool("scroll_to", "Scroll an element (by ref) into the centre of the viewport.", { tabId, ref }, async ({ tabId: id, ref: r }) => text(`${r} now at ${JSON.stringify(await ff.locate(id, r))}`));

tool("wait", "Wait N seconds (max 10) for the page to settle.", { seconds: z.number().min(0).max(10) }, async ({ seconds }) => {
  await sleep(seconds * 1000);
  return text(`waited ${seconds}s`);
});

// ---- debugging -------------------------------------------------------------------

tool(
  "read_console",
  "Console messages and uncaught errors buffered since the server connected. `pattern` is a regex filter; clear=true empties the buffer after reading.",
  { tabId: optTabId, pattern: z.string().optional(), limit: z.number().int().optional(), clear: z.boolean().optional() },
  async ({ tabId: id, pattern, limit, clear }) => {
    const entries = await ff.consoleEntries(id, { pattern, limit: limit ?? 100, clear });
    if (!entries.length) return text("(no console entries)");
    return text(entries.map((e) => `${new Date(e.ts).toISOString().slice(11, 23)} ${e.level.padEnd(5)} ${e.text}${e.at ? `  (${e.at})` : ""}`).join("\n"));
  },
);

tool(
  "read_network",
  "Network requests buffered since the server connected: method, status, mime, url. `pattern` filters url/status/mime by regex.",
  { tabId: optTabId, pattern: z.string().optional(), limit: z.number().int().optional(), clear: z.boolean().optional() },
  async ({ tabId: id, pattern, limit, clear }) => {
    const entries = await ff.networkEntries(id, { pattern, limit: limit ?? 100, clear });
    if (!entries.length) return text("(no network entries)");
    return text(entries.map((e) => `${e.method.padEnd(6)} ${String(e.error ?? e.status ?? "…").padEnd(4)} ${(e.mimeType ?? "").padEnd(24)} ${e.url}`).join("\n"));
  },
);

// ----------------------------------------------------------------------------------

process.on("uncaughtException", (e) => console.error(`[firefox-mcp] uncaught: ${e.stack ?? e}`));
process.on("unhandledRejection", (e) => console.error(`[firefox-mcp] unhandled: ${e?.stack ?? e}`));

await server.connect(new StdioServerTransport());
console.error(`[firefox-mcp] ready; will connect to Firefox on ${HOST}:${PORT} at first use`);
