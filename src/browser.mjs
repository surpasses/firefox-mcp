// Firefox: tab bookkeeping, frames and refs, input, screenshots, console and
// network buffers, all on top of the BiDi client.

import { BidiClient, toRemote, fromRemote } from "./bidi.mjs";
import { PAGE_SRC } from "./page-scripts.mjs";

// WebDriver key codes (https://w3c.github.io/webdriver/#keyboard-actions)
const KEYS = {
  enter: "", return: "", tab: "", backspace: "", delete: "", del: "",
  escape: "", esc: "", space: " ", insert: "",
  arrowup: "", up: "", arrowdown: "", down: "", arrowleft: "", left: "",
  arrowright: "", right: "", home: "", end: "", pageup: "", pagedown: "",
  shift: "", ctrl: "", control: "", alt: "", option: "",
  meta: "", cmd: "", command: "", win: "", windows: "",
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = String.fromCharCode(0xe031 + i - 1);
const MODIFIERS = new Set(["shift", "ctrl", "control", "alt", "option", "meta", "cmd", "command", "win", "windows"]);

const BUFFER_LIMIT = 1000;
const BUTTONS = { left: 0, middle: 1, right: 2 };

export class Firefox {
  constructor({ host = "127.0.0.1", port = 9222 } = {}) {
    this.host = host;
    this.port = port;
    this.client = null;
    this.tabIds = new Map(); // context -> n
    this.tabByN = new Map(); // n -> context
    this.nextTab = 1;
    this.console = new Map(); // context -> entries[]
    this.network = new Map(); // context -> Map(requestId -> entry)
  }

  async ensure() {
    if (this.client?.connected) return;
    const client = new BidiClient(this.host, this.port);
    await client.connect();
    await client.send("session.subscribe", {
      events: ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError", "browsingContext.contextDestroyed"],
    });
    client.on("log.entryAdded", (p) => {
      const ctx = p.source?.context ?? "?";
      const list = this.console.get(ctx) ?? [];
      const text = p.text ?? (p.args ?? []).map((a) => stringify(fromRemote(a))).join(" ");
      const frame = p.stackTrace?.callFrames?.[0];
      list.push({
        ts: p.timestamp, level: p.level, kind: p.type, method: p.method, text,
        at: frame ? `${frame.url}:${frame.lineNumber}:${frame.columnNumber}` : undefined,
      });
      if (list.length > BUFFER_LIMIT) list.splice(0, list.length - BUFFER_LIMIT);
      this.console.set(ctx, list);
    });
    client.on("network.beforeRequestSent", (p) => {
      const ctx = p.context ?? "?";
      const m = this.network.get(ctx) ?? new Map();
      m.set(p.request.request, {
        ts: p.timestamp, method: p.request.method, url: p.request.url, type: p.initiator?.type, status: null, mimeType: null,
      });
      if (m.size > BUFFER_LIMIT) m.delete(m.keys().next().value);
      this.network.set(ctx, m);
    });
    client.on("network.responseCompleted", (p) => {
      const e = this.network.get(p.context ?? "?")?.get(p.request.request);
      if (e) {
        e.status = p.response.status;
        e.mimeType = p.response.mimeType;
        e.fromCache = p.response.fromCache;
        e.bytes = p.response.bytesReceived;
      }
    });
    client.on("network.fetchError", (p) => {
      const e = this.network.get(p.context ?? "?")?.get(p.request.request);
      if (e) e.error = p.errorText;
    });
    client.on("browsingContext.contextDestroyed", (p) => {
      this.console.delete(p.context);
      this.network.delete(p.context);
      const n = this.tabIds.get(p.context);
      if (n !== undefined) {
        this.tabIds.delete(p.context);
        this.tabByN.delete(n);
      }
    });
    this.client = client;
  }

  // ---- tabs -----------------------------------------------------------------

  #idFor(context) {
    let n = this.tabIds.get(context);
    if (n === undefined) {
      n = this.nextTab++;
      this.tabIds.set(context, n);
      this.tabByN.set(n, context);
    }
    return n;
  }

  async contextFor(tabId) {
    await this.ensure();
    let ctx = this.tabByN.get(tabId);
    if (!ctx) {
      await this.tabs();
      ctx = this.tabByN.get(tabId);
    }
    if (!ctx) throw new Error(`Unknown tabId ${tabId}. Call tabs_context for the current list.`);
    return ctx;
  }

  async tabs() {
    await this.ensure();
    const { contexts } = await this.client.send("browsingContext.getTree", {});
    const out = [];
    for (const c of contexts) {
      const tabId = this.#idFor(c.context);
      let info = { title: "", visible: false };
      try {
        info = await this.page(c.context, "info");
      } catch {
        /* privileged page, e.g. about:preferences */
      }
      out.push({ tabId, url: c.url, title: info.title, active: !!info.visible, context: c.context });
    }
    return out;
  }

  async createTab(url) {
    await this.ensure();
    const { context } = await this.client.send("browsingContext.create", { type: "tab", background: false });
    const tabId = this.#idFor(context);
    try {
      await this.client.send("browsingContext.activate", { context });
    } catch {
      /* ignore */
    }
    if (url) return { tabId, ...(await this.navigate(tabId, url)) };
    return { tabId, url: "about:blank" };
  }

  async closeTab(tabId) {
    const ctx = await this.contextFor(tabId);
    await this.client.send("browsingContext.close", { context: ctx });
    this.tabIds.delete(ctx);
    this.tabByN.delete(tabId);
  }

  async activate(tabId) {
    const ctx = await this.contextFor(tabId);
    await this.client.send("browsingContext.activate", { context: ctx });
  }

  async navigate(tabId, url) {
    const ctx = await this.contextFor(tabId);
    if (url === "back" || url === "forward") {
      try {
        await this.client.send("browsingContext.traverseHistory", { context: ctx, delta: url === "back" ? -1 : 1 });
      } catch (e) {
        if (/no such history entry/i.test(e.message)) return { ...(await this.info(tabId)), note: `cannot go ${url}: no history entry in that direction` };
        throw e;
      }
      await sleep(500);
    } else {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      try {
        await this.client.send("browsingContext.navigate", { context: ctx, url, wait: "complete" }, 45_000);
      } catch (e) {
        if (!/timed out/.test(e.message)) throw e;
        return { ...(await this.info(tabId)), note: "load event did not fire within 45 s; page may still be loading" };
      }
    }
    return this.info(tabId);
  }

  async info(tabId) {
    const ctx = await this.contextFor(tabId);
    try {
      const i = await this.page(ctx, "info");
      return { url: i.url, title: i.title, viewport: `${i.vw}x${i.vh}`, scrollY: i.scrollY, docHeight: i.docHeight };
    } catch {
      const { contexts } = await this.client.send("browsingContext.getTree", { root: ctx });
      return { url: contexts[0]?.url, title: "", note: "page does not allow script (privileged or blank)" };
    }
  }

  async setViewport(tabId, width, height) {
    const ctx = await this.contextFor(tabId);
    await this.client.send("browsingContext.setViewport", { context: ctx, viewport: { width, height } });
    return this.info(tabId);
  }

  // ---- scripts ----------------------------------------------------------------

  /** Run one op of the in-page helper in `context`; returns parsed JSON. */
  async page(context, op, a, b) {
    const res = await this.client.send("script.callFunction", {
      functionDeclaration: PAGE_SRC,
      arguments: [toRemote(op), toRemote(a), toRemote(b)],
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (res.type === "exception") throw new Error(scriptError(res));
    return res.result.type === "string" ? JSON.parse(res.result.value) : fromRemote(res.result);
  }

  async evaluate(tabId, expression, frameKey = "f0") {
    const frames = await this.frames(tabId);
    const fr = frames.find((f) => f.key === frameKey);
    if (!fr) throw new Error(`No frame ${frameKey}; frames: ${frames.map((f) => f.key).join(", ")}`);
    const res = await this.client.send("script.evaluate", {
      expression,
      target: { context: fr.context },
      awaitPromise: true,
      resultOwnership: "none",
      serializationOptions: { maxObjectDepth: 6, maxDomDepth: 0 },
    });
    if (res.type === "exception") throw new Error(scriptError(res));
    return fromRemote(res.result);
  }

  // ---- frames and refs ------------------------------------------------------------

  /**
   * [{key:'f0'|'f1'..., context, ox, oy, w, h, url, parent, index}] with offsets relative
   * to the top viewport. Firefox runs cross-origin frames out of process and input actions
   * sent to the top context never reach them, so every input is dispatched on the frame's
   * own context with frame-local coordinates (see resolvePoint / focusedFrame).
   */
  async frames(tabId) {
    const top = await this.contextFor(tabId);
    const { contexts } = await this.client.send("browsingContext.getTree", { root: top });
    const out = [];
    let counter = 0;
    const walk = async (node, ox, oy, w, h, parent, index) => {
      const key = `f${counter++}`;
      const fr = { key, context: node.context, ox, oy, w, h, url: node.url, parent, index, children: [] };
      out.push(fr);
      if (!node.children?.length) return;
      let rects = [];
      try {
        rects = await this.page(node.context, "frameRects");
      } catch {
        /* no script access */
      }
      for (let i = 0; i < node.children.length; i++) {
        const r = rects[i] ?? { x: 0, y: 0, w: 0, h: 0 };
        fr.children.push(out.length);
        await walk(node.children[i], ox + r.x, oy + r.y, r.w, r.h, fr, i);
      }
    };
    await walk(contexts[0], 0, 0, 1e9, 1e9, null, -1);
    return out;
  }

  /** Deepest frame containing a top-viewport point, plus the point in that frame's coordinates. */
  async resolvePoint(tabId, x, y, frames) {
    frames ??= await this.frames(tabId);
    let fr = frames[0];
    for (;;) {
      const child = fr.children.map((i) => frames[i]).find((c) => x >= c.ox && x < c.ox + c.w && y >= c.oy && y < c.oy + c.h);
      if (!child) break;
      fr = child;
    }
    return { frame: fr, x: x - fr.ox, y: y - fr.oy };
  }

  /** The frame whose document currently has focus (follows focused <iframe> elements downwards). */
  async focusedFrame(tabId, frames) {
    frames ??= await this.frames(tabId);
    let fr = frames[0];
    for (;;) {
      if (!fr.children.length) break;
      let idx = -1;
      try {
        idx = await this.page(fr.context, "focusedFrameIndex");
      } catch {
        break;
      }
      if (idx < 0 || idx >= fr.children.length) break;
      fr = frames[fr.children[idx]];
    }
    return fr;
  }

  parseRef(refStr) {
    const m = /^(?:(f\d+):)?(ref_\d+)$/.exec(String(refStr).trim());
    if (!m) throw new Error(`Bad ref "${refStr}"; expected ref_N or fN:ref_N from read_page/find`);
    return { frameKey: m[1] ?? "f0", ref: m[2] };
  }

  /** Scroll the element into view and return its centre in top-viewport coordinates. */
  async locate(tabId, refStr) {
    const { frameKey, ref } = this.parseRef(refStr);
    let frames = await this.frames(tabId);
    let fr = frames.find((f) => f.key === frameKey);
    if (!fr) throw new Error(`Frame ${frameKey} no longer exists; run read_page again`);
    await this.page(fr.context, "scrollIntoView", ref);
    await sleep(80);
    frames = await this.frames(tabId); // offsets may have changed after scrolling
    fr = frames.find((f) => f.key === frameKey) ?? fr;
    const r = await this.page(fr.context, "rect", ref);
    // x/y: top-viewport coordinates (for reporting and screenshots); target: where to dispatch input.
    return { x: Math.round(r.cx + fr.ox), y: Math.round(r.cy + fr.oy), frame: fr, ref, target: { context: fr.context, x: r.cx, y: r.cy } };
  }

  async snapshot(tabId, filter = "interactive", maxItems = 600) {
    const frames = await this.frames(tabId);
    const result = [];
    for (const fr of frames) {
      try {
        const s = await this.page(fr.context, "snapshot", filter, maxItems);
        result.push({ frame: fr, ...s });
      } catch (e) {
        result.push({ frame: fr, url: fr.url, items: [], error: e.message });
      }
    }
    return result;
  }

  async find(tabId, query, selector) {
    const frames = await this.frames(tabId);
    const result = [];
    for (const fr of frames) {
      try {
        const s = await this.page(fr.context, "find", query, selector ?? null);
        if (s.items.length) result.push({ frame: fr, ...s });
      } catch {
        /* skip frames without script access */
      }
    }
    return result;
  }

  async setValue(tabId, refStr, value) {
    const { frameKey, ref } = this.parseRef(refStr);
    const frames = await this.frames(tabId);
    const fr = frames.find((f) => f.key === frameKey);
    if (!fr) throw new Error(`Frame ${frameKey} no longer exists; run read_page again`);
    return this.page(fr.context, "setValue", ref, value);
  }

  async pageText(tabId) {
    const frames = await this.frames(tabId);
    const parts = [];
    for (const fr of frames) {
      try {
        const t = await this.page(fr.context, "text");
        if (t.text.trim()) parts.push(fr.key === "f0" ? t.text : `\n--- frame ${fr.key} (${fr.url}) ---\n${t.text}`);
      } catch {
        /* skip */
      }
    }
    return parts.join("\n");
  }

  // ---- input -----------------------------------------------------------------

  /** Dispatch input actions on a specific browsing context (defaults to the tab's top frame). */
  async #actions(tabId, actions, context) {
    const ctx = context ?? (await this.contextFor(tabId));
    await this.client.send("input.performActions", { context: ctx, actions });
    await this.client.send("input.releaseActions", { context: ctx });
  }

  /** `target` (from locate) wins; otherwise x/y are top-viewport coordinates routed to the frame under them. */
  async #pointerTarget(tabId, { x, y, target }) {
    if (target) return target;
    const r = await this.resolvePoint(tabId, x, y);
    return { context: r.frame.context, x: r.x, y: r.y };
  }

  async click(tabId, { x, y, target, button = "left", count = 1, modifiers }) {
    const t = await this.#pointerTarget(tabId, { x, y, target });
    const btn = BUTTONS[button] ?? 0;
    const pointer = [{ type: "pointerMove", x: Math.round(t.x), y: Math.round(t.y), duration: 0 }];
    for (let i = 0; i < count; i++) pointer.push({ type: "pointerDown", button: btn }, { type: "pointerUp", button: btn });
    await this.#actions(tabId, withModifiers(pointer, "pointer", modifiers), t.context);
    return t;
  }

  async hover(tabId, { x, y, target }) {
    const t = await this.#pointerTarget(tabId, { x, y, target });
    await this.#actions(tabId, [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: Math.round(t.x), y: Math.round(t.y), duration: 0 }] }], t.context);
  }

  async drag(tabId, from, to) {
    const t = await this.#pointerTarget(tabId, from);
    const dx = t.x - from.x, dy = t.y - from.y; // same frame assumed for the end point
    await this.#actions(tabId, [
      {
        type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: Math.round(t.x), y: Math.round(t.y), duration: 0 }, { type: "pointerDown", button: 0 },
          { type: "pointerMove", x: Math.round(to.x + dx), y: Math.round(to.y + dy), duration: 200 }, { type: "pointerUp", button: 0 },
        ],
      },
    ], t.context);
  }

  /** Types into the focused element; keys go to the frame that owns the focus unless `context` is given. */
  async typeText(tabId, text, context) {
    context ??= (await this.focusedFrame(tabId)).context;
    const chars = Array.from(String(text));
    for (let i = 0; i < chars.length; i += 100) {
      const actions = [];
      for (const ch of chars.slice(i, i + 100)) {
        const v = ch === "\n" ? KEYS.enter : ch === "\t" ? KEYS.tab : ch;
        actions.push({ type: "keyDown", value: v }, { type: "keyUp", value: v });
      }
      await this.#actions(tabId, [{ type: "key", id: "kb", actions }], context);
    }
  }

  /** "Enter", "cmd+a", "shift+Tab", or several separated by spaces: "Backspace Backspace Enter". */
  async pressKeys(tabId, keys, repeat = 1, context) {
    context ??= (await this.focusedFrame(tabId)).context;
    const combos = String(keys).trim().split(/\s+/).filter(Boolean);
    const actions = [];
    for (let r = 0; r < repeat; r++) {
      for (const combo of combos) {
        const parts = combo.split("+").filter(Boolean);
        const mods = parts.filter((p) => MODIFIERS.has(p.toLowerCase()) && parts.length > 1).map((p) => KEYS[p.toLowerCase()]);
        const main = parts.filter((p) => !(MODIFIERS.has(p.toLowerCase()) && parts.length > 1)).map(keyValue);
        for (const m of mods) actions.push({ type: "keyDown", value: m });
        for (const k of main) actions.push({ type: "keyDown", value: k }, { type: "keyUp", value: k });
        for (const m of [...mods].reverse()) actions.push({ type: "keyUp", value: m });
      }
    }
    await this.#actions(tabId, [{ type: "key", id: "kb", actions }], context);
  }

  async scroll(tabId, { x, y, target, direction = "down", amount = 3 }) {
    const t = await this.#pointerTarget(tabId, { x, y, target });
    const px = amount * 100;
    const deltaX = direction === "right" ? px : direction === "left" ? -px : 0;
    const deltaY = direction === "down" ? px : direction === "up" ? -px : 0;
    await this.#actions(tabId, [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: Math.round(t.x), y: Math.round(t.y), deltaX, deltaY, duration: 0 }] }], t.context);
  }

  // ---- screenshots ------------------------------------------------------------

  /** Returns base64 PNG. `clip` = {x, y, width, height} in CSS px of the top viewport. */
  async screenshot(tabId, clip) {
    const ctx = await this.contextFor(tabId);
    const params = { context: ctx, origin: "viewport", format: { type: "image/png" } };
    if (clip) params.clip = { type: "box", ...clip };
    const { data } = await this.client.send("browsingContext.captureScreenshot", params);
    return data;
  }

  // ---- buffers -----------------------------------------------------------------

  async consoleEntries(tabId, { pattern, limit = 100, clear = false } = {}) {
    const ctxs = tabId === undefined ? [...this.console.keys()] : (await this.frames(tabId)).map((f) => f.context);
    let entries = [];
    for (const c of ctxs) entries.push(...(this.console.get(c) ?? []));
    if (clear) for (const c of ctxs) this.console.delete(c);
    if (pattern) {
      const re = new RegExp(pattern, "i");
      entries = entries.filter((e) => re.test(e.text) || re.test(e.at ?? ""));
    }
    entries.sort((a, b) => a.ts - b.ts);
    return entries.slice(-limit);
  }

  async networkEntries(tabId, { pattern, limit = 100, clear = false } = {}) {
    const ctxs = tabId === undefined ? [...this.network.keys()] : (await this.frames(tabId)).map((f) => f.context);
    let entries = [];
    for (const c of ctxs) entries.push(...(this.network.get(c)?.values() ?? []));
    if (clear) for (const c of ctxs) this.network.delete(c);
    if (pattern) {
      const re = new RegExp(pattern, "i");
      entries = entries.filter((e) => re.test(e.url) || re.test(String(e.status)) || re.test(e.mimeType ?? ""));
    }
    entries.sort((a, b) => a.ts - b.ts);
    return entries.slice(-limit);
  }
}

// ---- helpers ------------------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyValue(name) {
  if (name.length === 1) return name;
  const k = KEYS[name.toLowerCase()];
  if (!k) throw new Error(`Unknown key "${name}". Use a single character or one of: ${Object.keys(KEYS).join(", ")}`);
  return k;
}

/** Wrap a pointer/key action list so the given modifier keys are held for its whole duration. */
function withModifiers(actions, sourceType, modifiers) {
  const main = sourceType === "pointer"
    ? { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }
    : { type: "key", id: "kb", actions };
  if (!modifiers) return [main];
  const mods = String(modifiers).split("+").map((m) => m.trim().toLowerCase()).filter(Boolean).map((m) => {
    if (!MODIFIERS.has(m)) throw new Error(`Unknown modifier "${m}"; use shift, ctrl, alt, cmd (combine with +)`);
    return KEYS[m];
  });
  // Sources advance in lock-step ticks: hold modifiers down for one tick before and one after the main sequence.
  const pad = (n) => Array.from({ length: n }, () => ({ type: "pause", duration: 0 }));
  const keySeq = [...mods.map((v) => ({ type: "keyDown", value: v })), ...pad(actions.length), ...mods.reverse().map((v) => ({ type: "keyUp", value: v }))];
  main.actions = [...pad(mods.length), ...actions, ...pad(mods.length)];
  return [{ type: "key", id: "mods", actions: keySeq }, main];
}

function scriptError(res) {
  const d = res.exceptionDetails ?? {};
  const ex = d.exception ? fromRemote(d.exception) : null;
  const msg = d.text || (ex && typeof ex === "object" ? JSON.stringify(ex) : String(ex ?? "script exception"));
  return msg;
}

function stringify(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}
