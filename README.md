# firefox-mcp

Claude in Chrome, but for Firefox. An MCP server that attaches to your **running, signed-in
Firefox** over WebDriver BiDi and gives Claude Code the same kind of tools: list and open tabs,
navigate, screenshot, read the page as refs, click, type with real key events, fill forms,
evaluate JS, read the console and network log.

No Playwright, no Puppeteer, no bundled browser. Node 22 (global `WebSocket`), the MCP SDK and
zod. Everything else is the BiDi protocol Firefox ships with.

## Setup

1. Install once:

   ```sh
   git clone https://github.com/surpasses/firefox-mcp ~/firefox-mcp
   cd ~/firefox-mcp && npm install
   claude mcp add --scope user firefox -- node ~/firefox-mcp/server.mjs
   ```

2. Firefox only reads the remote-debugging flag at startup, so relaunch it with the helper.
   Your normal profile, tabs and logins are kept (session restore):

   ```sh
   ~/firefox-mcp/bin/firefox-debug --restart
   ```

   Without `--restart` it just tells you to quit Firefox first. Firefox shows a small robot
   icon in the URL bar while the remote agent is on. It listens on `127.0.0.1` only.

3. In Claude Code, the tools appear as `mcp__firefox__*`. Start with `tabs_context`.

Port defaults to 9222; override with `FIREFOX_MCP_PORT` for both the launcher and the server.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context` | List tabs: id, url, title, active marker. Ids are stable while the server runs. |
| `tabs_create` / `tabs_close` / `tabs_activate` | Open (optionally with a URL), close, focus a tab. |
| `navigate` | URL, `back` or `forward`. Waits for load (45 s cap). |
| `screenshot` | Viewport PNG. `region` crops, `savePath` also writes a file. |
| `read_page` | Elements with refs (`ref_12`, or `f1:ref_3` inside frame 1), role, name, value, position. `filter=all` adds headings and text. |
| `find` | Regex over name/label/placeholder/id/href, or a CSS `selector`. |
| `get_page_text` | Visible text, all frames. |
| `click` / `hover` / `drag` | By ref (scrolled into view first) or by viewport coordinates. Modifiers, double and triple click. |
| `type` | Real key events into the focused element or a ref. `clear` selects-all first, `pressEnter` submits. |
| `press_key` | `Enter`, `Tab`, `cmd+a`, `shift+Tab`, `Backspace Backspace Enter`, with `repeat`. |
| `form_input` | Set a value directly (fires input/change): text, select, checkbox, radio, contenteditable. |
| `scroll` / `scroll_to` | Wheel scroll at a point or ref; scroll a ref into the centre. |
| `evaluate` | Run a JS expression, optionally inside a frame (`frame: "f1"`). |
| `read_console` / `read_network` | Buffered since connect, regex-filterable, `clear` to reset. |
| `resize_viewport` | Set the viewport size (phone widths etc.). |
| `wait` | Sleep up to 10 s. |

## Frames and Fission

Firefox runs cross-origin iframes out of process ("Fission"). Input actions sent to the top
frame's context reach the `<iframe>` element but are never routed into the child process, and
focusing a child field by script then typing on the top frame does not work either.

This server therefore treats frames as first class: `read_page` and `find` walk every frame and
prefix refs with the frame key; every click, hover, scroll and keystroke is dispatched on the
context of the frame that owns the target (by ref, by hit-testing the coordinates against the
frame rectangles, or by following the focused `<iframe>` chain for typing). Shopify's hosted
checkout card fields, Stripe Elements and similar embedded forms work through the normal
`click` and `type` tools.

## Test

```sh
npm test
```

Boots a throwaway **headless** Firefox on port 9333 with its own profile (your real Firefox is
untouched), serves a two-origin fixture, and checks tabs, navigation, snapshot, refs, form
input, real typing, cross-origin iframe input, screenshots, page text, console and network
capture, history and tab close.

## Not there yet

* GIF recording of a sequence of actions.
* Natural-language `find` (the Chrome one calls a model); `find` here is regex or CSS.
* Downloads and file uploads.
* Multiple simultaneous BiDi clients: Firefox allows one session, so run one server at a time.
