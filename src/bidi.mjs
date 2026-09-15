// Minimal WebDriver BiDi client over Node 22's global WebSocket.
// Connects to a Firefox started with `--remote-debugging-port <port>`.

export class BidiClient {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(host = "127.0.0.1", port = 9222) {
    this.host = host;
    this.port = port;
    this.connected = false;
    this.sessionId = null;
  }

  async connect() {
    // Firefox >= 129 speaks BiDi only; the remote agent answers HTTP (with a 404) on
    // its port, and the BiDi WebSocket lives at /session. Probe first for a clear error.
    try {
      await fetch(`http://${this.host}:${this.port}/`, { signal: AbortSignal.timeout(3000) });
    } catch (e) {
      throw new Error(
        `No Firefox remote agent on ${this.host}:${this.port}. Quit Firefox and relaunch it with the flag, e.g. ` +
          `~/firefox-mcp/bin/firefox-debug --restart (runs: firefox --remote-debugging-port ${this.port}). (${e.message})`,
      );
    }
    const url = `ws://${this.host}:${this.port}/session`;

    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`WebSocket to ${url} failed`)), { once: true });
    });
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", () => {
      this.connected = false;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Firefox connection closed"));
      }
      this.#pending.clear();
    });
    this.#ws = ws;
    this.connected = true;

    const session = await this.send("session.new", { capabilities: { alwaysMatch: {} } });
    this.sessionId = session.sessionId;
    this.browser = session.capabilities;
    return session;
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.type === "event") {
      for (const fn of this.#listeners.get(msg.method) ?? []) {
        try {
          fn(msg.params);
        } catch (e) {
          console.error(`[firefox-mcp] listener for ${msg.method} threw: ${e.message}`);
        }
      }
      return;
    }
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "success") p.resolve(msg.result);
    else p.reject(new Error(`${msg.error ?? "error"}: ${msg.message ?? ""}`.trim()));
  }

  send(method, params = {}, timeoutMs = 60_000) {
    if (!this.connected) return Promise.reject(new Error("Not connected to Firefox"));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }
}

/** JS value -> BiDi LocalValue (for script.callFunction arguments). */
export function toRemote(v) {
  if (v === undefined) return { type: "undefined" };
  if (v === null) return { type: "null" };
  switch (typeof v) {
    case "string":
      return { type: "string", value: v };
    case "boolean":
      return { type: "boolean", value: v };
    case "bigint":
      return { type: "bigint", value: v.toString() };
    case "number":
      if (Number.isNaN(v)) return { type: "number", value: "NaN" };
      if (v === Infinity) return { type: "number", value: "Infinity" };
      if (v === -Infinity) return { type: "number", value: "-Infinity" };
      if (Object.is(v, -0)) return { type: "number", value: "-0" };
      return { type: "number", value: v };
    default:
      if (Array.isArray(v)) return { type: "array", value: v.map(toRemote) };
      return { type: "object", value: Object.entries(v).map(([k, val]) => [k, toRemote(val)]) };
  }
}

/** BiDi RemoteValue -> plain JS (best effort, for `evaluate` results). */
export function fromRemote(v) {
  if (!v || typeof v !== "object") return v;
  switch (v.type) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "string":
    case "boolean":
      return v.value;
    case "bigint":
      return `${v.value}n`;
    case "number":
      return typeof v.value === "number" ? v.value : Number(v.value === "-0" ? "-0" : v.value);
    case "array":
    case "set":
      return (v.value ?? []).map(fromRemote);
    case "object":
    case "map":
      return Object.fromEntries((v.value ?? []).map(([k, val]) => [typeof k === "string" ? k : JSON.stringify(fromRemote(k)), fromRemote(val)]));
    case "date":
      return v.value;
    case "regexp":
      return `/${v.value.pattern}/${v.value.flags ?? ""}`;
    case "node": {
      const n = v.value ?? {};
      return `<${(n.localName ?? "#node").toLowerCase()}${Object.entries(n.attributes ?? {})
        .map(([k, val]) => ` ${k}="${val}"`)
        .join("")}>`;
    }
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
    case "error":
      return "[error]";
    case "promise":
      return "[promise]";
    case "window":
      return "[window]";
    default:
      return v.value !== undefined ? v.value : `[${v.type}]`;
  }
}
