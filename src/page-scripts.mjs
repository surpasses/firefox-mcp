// Code that runs INSIDE the page via script.callFunction. It is shipped as
// `fxmcp.toString()`, so it must be fully self-contained: no imports, no
// references to module scope. One function, dispatched on `op`, so the helpers
// are shared. Every op returns a JSON string.

export function fxmcp(op, a, b) {
  const S = (globalThis.__fxmcp ??= { byEl: new WeakMap(), byRef: new Map(), n: 0 });
  const INTERACTIVE =
    "a[href],button,input,select,textarea,summary,label,iframe,frame,[role=button],[role=link],[role=checkbox],[role=radio]," +
    "[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox]," +
    "[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable]:not([contenteditable=false])," +
    '[tabindex]:not([tabindex="-1"]),[onclick]';
  const TEXTY = /^(H1|H2|H3|H4|H5|H6|P|LI|TD|TH|DT|DD|LEGEND|FIGCAPTION|BLOCKQUOTE|PRE|CODE|SPAN|DIV|STRONG|EM|SMALL|B|I|TIME|ADDRESS|CAPTION)$/;

  const refFor = (el) => {
    let r = S.byEl.get(el);
    if (!r) {
      r = "ref_" + ++S.n;
      S.byEl.set(el, r);
      S.byRef.set(r, el);
    }
    return r;
  };
  const get = (ref) => {
    const el = S.byRef.get(ref);
    if (!el || !el.isConnected) throw new Error(`Unknown or stale ${ref}: run read_page or find again`);
    return el;
  };
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const inViewport = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName;
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return ty === "text" ? "textbox" : ty;
    }
    const map = {
      A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", LABEL: "label",
      IFRAME: "iframe", FRAME: "iframe", IMG: "img", H1: "heading", H2: "heading", H3: "heading", H4: "heading",
      H5: "heading", H6: "heading",
    };
    return map[t] || (el.isContentEditable ? "textbox" : t.toLowerCase());
  };
  const nameOf = (el) => {
    const lab = el.getAttribute("aria-label");
    if (lab) return clean(lab).slice(0, 160);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" "));
      if (t) return t.slice(0, 160);
    }
    if (el.labels && el.labels.length) {
      const t = clean(el.labels[0].innerText);
      if (t) return t.slice(0, 160);
    }
    for (const attr of ["placeholder", "title", "alt", "name"]) {
      const v = el.getAttribute(attr);
      if (v) return clean(v).slice(0, 160);
    }
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.value) return clean(el.value);
    return clean(el.innerText ?? el.textContent).slice(0, 160);
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const it = {
      ref: refFor(el), role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
    };
    if (!inViewport(r)) it.offscreen = true;
    if (el.id) it.id = el.id;
    if (el.tagName === "INPUT") it.type = (el.type || "text").toLowerCase();
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !["password", "checkbox", "radio"].includes(it.type) && el.value)
      it.value = String(el.value).slice(0, 120);
    if (el.tagName === "INPUT" && it.type === "password" && el.value) it.value = "•".repeat(Math.min(el.value.length, 12));
    if (el.tagName === "SELECT") {
      it.value = el.options[el.selectedIndex]?.text?.trim() ?? "";
      it.options = Array.from(el.options).map((o) => o.text.trim()).slice(0, 40);
    }
    if (el.type === "checkbox" || el.type === "radio") it.checked = !!el.checked;
    const ac = el.getAttribute("aria-checked");
    if (ac) it.checked = ac === "true";
    const ax = el.getAttribute("aria-expanded");
    if (ax) it.expanded = ax === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") it.disabled = true;
    if (el.tagName === "A" && el.href) it.href = el.href.slice(0, 200);
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") it.src = (el.src || "").slice(0, 200);
    if (/^H[1-6]$/.test(el.tagName)) it.level = +el.tagName[1];
    return it;
  };
  const isLeafText = (el) =>
    TEXTY.test(el.tagName) &&
    !el.matches(INTERACTIVE) &&
    clean(el.innerText) &&
    !Array.from(el.children).some((c) => TEXTY.test(c.tagName) || c.matches(INTERACTIVE));
  const info = () => ({
    url: location.href, title: document.title, visible: document.visibilityState === "visible",
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), docHeight: document.documentElement.scrollHeight,
  });

  let result;
  switch (op) {
    case "info":
      result = info();
      break;

    case "frameRects":
      result = Array.from(document.querySelectorAll("iframe,frame")).map((f) => {
        const r = f.getBoundingClientRect();
        return { x: r.left + f.clientLeft, y: r.top + f.clientTop, w: f.clientWidth, h: f.clientHeight, src: (f.src || "").slice(0, 200) };
      });
      break;

    case "focusedFrameIndex": {
      const el = document.activeElement;
      if (!el || (el.tagName !== "IFRAME" && el.tagName !== "FRAME")) result = -1;
      else result = Array.from(document.querySelectorAll("iframe,frame")).indexOf(el);
      break;
    }

    case "snapshot": {
      const filter = a || "interactive";
      const max = b || 600;
      const items = [];
      let truncated = false;
      const els = filter === "interactive" ? document.querySelectorAll(INTERACTIVE) : document.body ? document.body.querySelectorAll("*") : [];
      for (const el of els) {
        if (items.length >= max) {
          truncated = true;
          break;
        }
        if (!visible(el)) continue;
        if (filter === "interactive" && el.tagName === "LABEL" && el.control) continue;
        if (filter !== "interactive" && !el.matches(INTERACTIVE) && !isLeafText(el)) continue;
        items.push(describe(el));
      }
      result = { ...info(), truncated, items };
      break;
    }

    case "find": {
      const q = String(a ?? "");
      let re;
      try {
        re = new RegExp(q, "i");
      } catch {
        re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const sel = b || null;
      const els = sel ? document.querySelectorAll(sel) : document.querySelectorAll(INTERACTIVE + ",h1,h2,h3,h4,h5,h6,p,li,td,th,img,span,div");
      const items = [];
      let total = 0;
      for (const el of els) {
        if (!visible(el)) continue;
        if (!sel) {
          if (!el.matches(INTERACTIVE) && !isLeafText(el) && el.tagName !== "IMG") continue;
          const hay = [nameOf(el), el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("href"),
            el.getAttribute("data-testid"), el.getAttribute("autocomplete"), typeof el.className === "string" ? el.className : ""]
            .filter(Boolean).join(" | ");
          if (!re.test(hay)) continue;
        }
        total++;
        if (items.length < 20) items.push(describe(el));
      }
      result = { total, items };
      break;
    }

    case "scrollIntoView": {
      const el = get(a);
      el.scrollIntoView({ block: "center", inline: "center" });
      result = "ok";
      break;
    }

    case "rect": {
      const el = get(a);
      const r = el.getBoundingClientRect();
      const l = Math.max(r.left, 0), t = Math.max(r.top, 0), rr = Math.min(r.right, innerWidth), bb = Math.min(r.bottom, innerHeight);
      if (rr <= l || bb <= t) throw new Error(`${a} is outside the viewport even after scrolling`);
      result = { cx: (l + rr) / 2, cy: (t + bb) / 2, w: r.width, h: r.height };
      break;
    }

    case "setValue": {
      const el = get(a);
      const value = b;
      if (el.tagName === "SELECT") {
        const o = Array.from(el.options).find((o) => o.value === String(value) || o.text.trim() === String(value).trim());
        if (!o) throw new Error(`No option "${value}" in ${a}; options: ${Array.from(el.options).map((o) => o.text.trim()).join(", ")}`);
        el.value = o.value;
      } else if (el.type === "checkbox" || el.type === "radio") {
        const want = value === true || value === "true" || value === 1 || value === "1";
        if (el.checked !== want) el.click();
      } else if (el.isContentEditable) {
        el.focus();
        el.textContent = String(value);
      } else {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        el.focus();
        if (setter && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) setter.call(el, String(value));
        else el.value = String(value);
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      result = describe(el);
      break;
    }

    case "text":
      result = { ...info(), text: (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").slice(0, 80000) };
      break;

    default:
      throw new Error(`unknown op ${op}`);
  }
  return JSON.stringify(result);
}

export const PAGE_SRC = fxmcp.toString();
