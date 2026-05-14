# Plugin-Computeruse vs trycua/cua — Gap Analysis (Windows-focused)

## 1. Scope and architecture comparison

**plugin-computeruse** (`C:/Users/Administrator/Documents/eliza/plugins/plugin-computeruse`) is a **TypeScript, in-process elizaOS plugin** that drives the host machine directly. Layers:

- Service: `src/services/computer-use-service.ts` — single `ComputerUseService` (~1700 LOC) routes desktop/browser/window/file/terminal commands, runs an approval manager, and owns the SceneBuilder.
- Actions: `src/actions/use-computer.ts` (13 desktop verbs), `src/actions/window.ts` (9 window verbs), `src/actions/use-computer-agent.ts` (autonomous loop).
- Actor / Brain / Cascade / Dispatch in `src/actor/` — autonomous agent loop with a deterministic OCR/AX grounding `Actor` plus an optional VLM stub (`OsAtlasProActor`). `src/actor/computer-interface.ts` is a thin host wrapper.
- Scene builder: `src/scene/scene-builder.ts`, dHash deltas (`scene/dhash.ts`), OCR adapter, apps enumeration, `a11y-provider.ts` per-OS providers.
- Platform: `src/platform/{capture,driver,nut-driver,desktop,screenshot,windows-list,displays,a11y,coords,capabilities,permissions,browser,terminal,file-ops,process-list}.ts`.
- Mobile: `src/mobile/{android,ios}-bridge.ts` (bridges to companion apps; iOS scope is intentionally limited per `docs/IOS_CONSTRAINTS.md`).
- OSWorld harness: `src/osworld/{adapter,action-converter,types}.ts`.
- Routes/UI: `src/routes/*` (approvals stream, sandbox, compat).

**trycua/cua** is a **multi-language, sandbox-first stack** (Python SDK + Swift/Rust drivers + Lume VMs + Kasm web shell). Critical pieces:

- `libs/python/computer-server/computer_server/handlers/{windows,macos,linux,android,vnc,generic}.py` — the over-the-wire handler set hosted **inside a target VM/sandbox** and exposed via REST + WebSocket + gRPC + MCP.
- `libs/python/computer/computer/interface/{base,generic,windows,macos,linux,android}.py` — typed SDK client (`BaseComputerInterface`, ~58 methods).
- `libs/python/agent/cua_agent` — agent loop with multi-provider model adapters (`anthropic`, `openai-operator`, `os-atlas`, `uitars`, etc.).
- `libs/python/computer/computer/providers/{cloud,docker,lume,lumier,winsandbox}` — sandbox/VM provisioners.
- `libs/lume` (Swift, macOS-only) — Virtualization.Framework VM manager.
- `libs/python/cua-bench`, `libs/python/som` (Screen-of-Marks / OmniParser), CuaBot (multi-agent), Kasm web desktop.
- Windows runtime stack inside the VM: `pynput`, `pywin32` (`win32gui`/`win32api`/`win32con`), `PIL.ImageGrab`, `ctypes`, `mslex` for shell. Accessibility tree is delivered via the same handler over the wire.

The shapes differ fundamentally: **cua is a remote sandbox protocol with thick SDKs and a VM management layer; plugin-computeruse is a local in-process driver**. Both expose roughly the same verbs.

## 2. Capability matrix

Legend: Y = implemented; P = partial / fragile; N = absent. Each row pairs cua's capability with ours and notes per-OS posture in our plugin.

| Capability | trycua/cua | plugin-computeruse | Win | Mac | Linux | File / line of ours |
|---|---|---|---|---|---|---|
| Screenshot (primary display) | Y (PIL.ImageGrab + handler) | Y (nut-js default; PowerShell System.Drawing fallback) | Y | Y | Y | `src/platform/capture.ts:237-259`, `nut-driver.ts` |
| Per-display screenshot | Y | Y (PS crop / screencapture -D / import crop) | Y | Y | Y | `capture.ts:64-105` |
| Region screenshot | Y | Y | Y | Y | Y | `capture.ts:111-140` |
| Left/right/double click | Y | Y (nut-js, cliclick/xdotool/PS fallback) | Y | Y | Y | `driver.ts`, `desktop.ts`, `nut-driver.ts` |
| Mouse move / drag / scroll | Y | Y | Y | Y | Y | same |
| `mouse_down` / `mouse_up` (hold-state) | **Y** | **N (no held-button primitives exposed)** | N | N | N | gap — must add to `driver.ts` |
| `key_down` / `key_up` (hold-state) | **Y** | **P** (nut exposes pressKey/releaseKey internally but service only routes `key`/`key_combo`) | P | P | P | `nut-driver.ts:38-43` plumbing exists, not surfaced |
| Hotkey / key combo | Y | Y | Y | Y | Y | service `key_combo` |
| Type text (incl. unicode) | Y | Y | Y | Y | Y | nut/desktop type |
| Get cursor position | **Y** | **N** | N | N | N | gap |
| Clipboard get/set | **Y** (`copy_to_clipboard`, `set_clipboard`) | **N** (intentionally suppressed in `toComputerUseActionResult`) | N | N | N | gap; native cmds: PowerShell `Get/Set-Clipboard`, `pbcopy/pbpaste`, `xclip/wl-copy` |
| List windows | Y | Y | Y (PS `Get-Process.MainWindowTitle`) | Y (osascript) | Y (wmctrl/xdotool) | `windows-list.ts:210-226` |
| Focus / activate window | Y | Y | Y (`SetForegroundWindow`) | Y | Y | `windows-list.ts:230-267` |
| Min / max / restore / close window | Y | Y | Y (`ShowWindow`) / **close = Stop-Process (destructive!)** | Y | Y | `windows-list.ts:435-560` — see note below |
| Move/resize window | Y (`set_window_size/position`) | P (move only, no resize in WINDOW action) | P | P | P | `windows-list.ts:415-431` — exposes only `move` |
| Get window bounds / size / position | Y (`get_window_size`, `get_window_position`, `get_active_window_bounds`) | **N** (only listWindows; no per-window geometry) | N | N | N | gap |
| Get current/foreground window id | Y | N | N | N | N | gap |
| Accessibility tree | Y (UIA on Win, AX on Mac, AT-SPI on Linux, all via handler) | Y but **shallow** — top-50 children via `UIAutomationClient` PowerShell snapshot | P | P (osascript JXA) | P (python3-atspi / hyprctl / swaymsg) | `scene/a11y-provider.ts:387-444` |
| Find element by role/title | Y (`find_element`) | **N** (Scene grounding by id, not by query) | N | N | N | gap |
| Launch app | Y (`launch`) | **N** (would use SHELL plugin) | N | N | N | optional |
| Open file/URL | Y (`open`) | P (browser open via puppeteer; no OS `open`) | N | N | N | optional |
| Set wallpaper / DE info | Y | N | N | N | N | low priority |
| Run shell command | Y (`run_command` with stdout/stderr/exit) | Y via `executeTerminalAction` | Y | Y | Y | `services/computer-use-service.ts:939` |
| File read/write/list/delete | Y | Y | Y | Y | Y | `platform/file-ops.ts` |
| Browser CDP (DOM, click, type, JS exec) | P (`playwright_exec`) | **Y (richer)** — puppeteer-core with DOM scrape, clickables, tabs, headless config | Y | Y | Y | `platform/browser.ts` |
| Multi-monitor coordinate translation | implicit | **Y** (`displays.ts`, logical/backing coord modes, `displayId` param) | Y | Y | Y | `platform/coords.ts`, `displays.ts` |
| Agent loop (goal → click) | Y (multi-provider, OS-Atlas, Operator, Anthropic CUA) | Y (Brain/Cascade/Actor, deterministic OCR/AX, OsAtlas-pro stub) | Y | Y | Y | `actor/*`, `actions/use-computer-agent.ts` |
| OSWorld harness | Y (cua-bench) | Y | Y | Y | Y | `src/osworld/*` |
| ScreenSpot / Windows-Arena benches | Y | **N** | N | N | N | gap |
| Trajectory recording / export | Y | P (structured logger events, not a packaged exporter) | P | P | P | `use-computer-agent.ts` log lines |
| Set-of-Marks / VLM grounding pre-processor | Y (`som`/OmniParser) | P (dHash + OCR adapter exists; no SoM overlay) | P | P | P | `scene/{dhash,ocr-adapter}.ts` |
| Sandbox / VM provisioning | Y (lume, Docker, Cloud, winsandbox) | **N** — runs on host only | N | N | N | gap |
| MCP server surface | Y (`mcp_server.py`) | **N** | N | N | N | gap |
| gRPC/REST/WebSocket protocol | Y | P (HTTP routes for approvals + sandbox compat only) | P | P | P | `src/routes/*` |
| Approval gating / human-in-loop | P (sandbox-level) | **Y (richer)** — 4 modes, SSE stream, REST | Y | Y | Y | `src/approval-manager.ts`, `routes/computer-use-compat-routes.ts` |
| Android control | Y (handler + emulator) | Y (bridge in `mobile/android-bridge.ts`) | n/a | n/a | n/a | symmetric |
| iOS control | partial | P (`docs/IOS_CONSTRAINTS.md` honest scope) | n/a | n/a | n/a | symmetric |

## 3. Gaps relative to trycua/cua (Windows-focused)

**G1 — Missing primitives.** `mouse_down`/`mouse_up`, `key_down`/`key_up`, `get_cursor_position`, clipboard get/set, per-window `get_bounds/size/position`, `get_foreground_window`, `find_element`. On Windows these are one-liners in PowerShell or `user32.dll` (`GetCursorPos`, `Get-Clipboard`/`Set-Clipboard`, `GetWindowRect`, `GetForegroundWindow`). nut-js already exposes `pressButton`/`releaseButton` (`src/platform/nut-driver.ts:32`) so plumbing is short.

**G2 — Shallow Windows a11y tree.** `src/scene/a11y-provider.ts:396-419` walks only `ContentViewWalker.GetFirstChild` siblings of `RootElement` (max 50 top-level windows). cua's UIA traversal is full-depth with control type, AutomationId, `IsEnabled`, BoundingRectangle, and parent/child linkage. We should: (a) walk depth-first up to a configurable depth, (b) emit `AutomationId`, `ControlType`, `IsEnabled`, `IsKeyboardFocusable`, `HelpText`, (c) cache per HWND so re-snapshots are cheap.

**G3 — Native screen capture path.** Windows path shells out to PowerShell + System.Drawing each frame (`capture.ts:242-258`) — slow (200-800 ms), launches `powershell.exe`. cua uses `PIL.ImageGrab` directly. nut-js's `screen.capture` is already wired (`nut-driver.ts:88-110`) and is the default; the PowerShell path is the per-display fallback. For high-frequency capture we should consider DXGI Desktop Duplication via a native add-on or a packaged `screenshot-desktop`/`screenshot` Rust binding. Even staying in JS, calling `nut-js` for the per-display path (cropping post-capture) is much faster than spawning PowerShell.

**G4 — Window close is destructive on Windows.** `src/platform/windows-list.ts:556-559` calls `Stop-Process -Id $pid` to "close" a window. That kills the entire process. cua uses `PostMessage WM_CLOSE` / `IUIAutomation` `Close` patterns. Fix: P/Invoke `PostMessageW(hwnd, WM_CLOSE, 0, 0)` via `Add-Type` (still PS) or via FFI in `nut-driver`.

**G5 — No window resize action.** `windowAction` exposes `move` (`src/actions/window.ts:24-34`) but no `resize`. `setWindowBounds` (`windows-list.ts:273`) already accepts width/height — only the action surface needs another verb (`resize`) and a `width/height` parameter.

**G6 — Window IDs use PIDs.** `windows-list.ts:218` returns `Id: String(p.Id)` which is the **process ID**, not the HWND. Two windows of the same process collapse to one entry and `MainWindowHandle` is shared. Fix: enumerate via `EnumWindows`/`GetWindowText` and key by HWND.

**G7 — No element-by-query search.** cua's `find_element(role, title)` is heavily used by agent prompting. Our cascade resolves by stable `a<displayId>-<seq>` id which works once a scene is built but doesn't help an agent referring to "the Save button". Add `WINDOW_FIND_ELEMENT` (or a `COMPUTER_USE_FIND_ELEMENT`) that runs UIA `TreeWalker` with a `PropertyCondition(Name=…)` on Windows, `AXUIElement` query on macOS, AT-SPI find on Linux.

**G8 — No clipboard.** Trivial to add. Windows: `powershell Get-Clipboard` / `Set-Clipboard -Value`. macOS: `pbpaste` / `pbcopy`. Linux: prefer `wl-copy`/`wl-paste`, fall back to `xclip -selection clipboard`.

**G9 — No MCP server surface.** cua exposes its handlers over MCP; this is becoming the common contract for desktop agents. The eliza route layer (`src/routes/computer-use-routes.ts`) is REST-only. Adding a `@modelcontextprotocol/sdk` server that fronts `ComputerUseService.executeCommand()` would let external Claude/Code MCP clients drive the host.

**G10 — No sandbox/VM mode.** cua's killer differentiator is that it runs the same SDK against a Lume VM, a Docker container, Windows Sandbox, or the cloud. We have no equivalent. For Windows specifically, `winsandbox` is a thin `WSB`-config wrapper that's worth porting (zero-license cost on Pro/Enterprise hosts).

**G11 — No SoM / OmniParser preprocessor.** `src/scene/dhash.ts` and `ocr-adapter.ts` give us dirty-block detection and OCR, but we don't emit Set-of-Marks numbered overlays for VLM consumption. cua's `som` library ships with OmniParser weights and is used by their Operator/UI-TARS adapters.

**G12 — Trajectory recording is logger-only.** `use-computer-agent.ts` emits `evt: "computeruse.agent.step"` log lines (`src/actions/use-computer-agent.ts:13`) but we have no on-disk trajectory exporter compatible with OSWorld/Windows-Arena.

**G13 — Benchmarks missing.** Only OSWorld is wired (`src/osworld/adapter.ts`). No ScreenSpot, no Windows-Arena, no GUI-WorldArena adapters.

**G14 — No multi-provider agent backends.** Our `OsAtlasProActor` is a stub (`src/actor/actor.ts:18`). cua ships Anthropic computer-use, OpenAI Operator, OS-Atlas, UI-TARS adapters. We should at least add an Anthropic computer-use adapter that translates Claude's `computer_20241022`/`20250124` tool calls into our `DesktopActionParams`.

## 4. What we have that trycua/cua doesn't (do not regress)

- **Approval manager + SSE stream** (`src/approval-manager.ts`, `routes/computer-use-compat-routes.ts`) — four modes (`full_control`, `smart_approve`, `approve_all`, `off`), per-command audit and live UI subscription. cua's gating is sandbox-level.
- **Richer browser surface** — full puppeteer-core lifecycle with tabs, DOM JSON, clickables enumeration, JS eval, wait-conditions, plus headless config. cua only has a `playwright_exec` shim.
- **First-class multi-monitor model** (`src/platform/{displays,coords,capture}.ts`, `docs/MULTI_MONITOR.md`) with explicit logical/backing coord modes and per-display capture. cua docs do not surface this.
- **In-process zero-RPC latency.** Every action is a TS function call. cua's cheapest action pays a WebSocket/REST round trip.
- **Deterministic OCR/AX grounding** (`src/actor/actor.ts`) as the default — no model needed for "click element a47", reproducible across runs.
- **Wayland-compositor a11y fallback** (`hyprctl`, `swaymsg` in `a11y-provider.ts:118-213`) — cua handlers don't enumerate Hyprland/Sway windows when AT-SPI is locked down.
- **Wider role gating + contextGate** baked into elizaOS actions.

## 5. Prioritized implementation plan

Effort = S (≤ 1 day), M (1–3 days), L (≥ 1 week). Impact ranks 1 (highest) → 3.

**P1 — Close the primitive parity gap. Impact 1 / Effort S.**
- Add `mouse_down`, `mouse_up`, `key_down`, `key_up`, `get_cursor_position`, `find_element` to `useComputerAction` enum and `ComputerUseService.executeDesktopAction` (`src/services/computer-use-service.ts:324`).
- Wire to nut-js `pressButton`/`releaseButton`/`pressKey`/`releaseKey` (`src/platform/nut-driver.ts:32-43`) and `mouse.getPosition` (or `screen.cursorPosition` polyfill via `nut.mouse.position()` — verify upstream API).
- Add `COMPUTER_USE_GET_CURSOR` and `WINDOW_GET_BOUNDS` to action catalog.
- Per-OS legacy fallback: PS `[System.Windows.Forms.Cursor]::Position`, cliclick `p:`, xdotool `getmouselocation`.

**P2 — Clipboard primitives. Impact 1 / Effort S.**
- New `src/platform/clipboard.ts` with `getClipboard()` / `setClipboard(text)`.
- Windows: PowerShell `Get-Clipboard` / `Set-Clipboard`. Mac: `pbpaste` / `pbcopy`. Linux: prefer `wl-copy`/`wl-paste`, fall back to `xclip`.
- Surface as `COMPUTER_USE_CLIPBOARD_GET/SET`. Re-enable clipboard pass-through in `toComputerUseActionResult` (`src/actions/helpers.ts`).

**P3 — Fix Windows window-close and IDs. Impact 1 / Effort S.**
- Replace `Stop-Process` close (`src/platform/windows-list.ts:556-559`) with `PostMessageW(hwnd, WM_CLOSE, 0, 0)` via P/Invoke.
- Switch listing to `EnumWindows` so each HWND is a separate row; map `id` → HWND string. Update focus/move/show paths to take HWND instead of resolving PID → `MainWindowHandle` (`windows-list.ts:262`, `windows-list.ts:346`).

**P4 — Full UIAutomation walk. Impact 1 / Effort M.**
- Rewrite `WindowsAccessibilityProvider.snapshot` (`src/scene/a11y-provider.ts:396`) to walk `TreeWalker.ControlViewWalker` depth-first with depth cap (config), emit `AutomationId`, `ControlType.ProgrammaticName`, `Name`, `IsEnabled`, `IsKeyboardFocusable`, `HelpText`, `BoundingRectangle`, parent id.
- Cache by HWND between `tick()`s in `SceneBuilder`.
- Add `WindowsAccessibilityProvider.findByQuery(role?, name?)` used by P1's `find_element`.
- Same depth/extra-property treatment for `DarwinAccessibilityProvider` (osascript JXA already structured, just emit more fields) and `LinuxAccessibilityProvider`.

**P5 — Replace PowerShell capture with nut-js / native. Impact 2 / Effort M.**
- Make `capturePrimaryDisplay()` / `captureDisplay()` (`src/platform/capture.ts:64`) prefer `nut.screen.capture()` then crop to display bounds, falling back to the existing PS path only when nut is unavailable.
- For higher-rate capture, evaluate `node-screenshots` (Rust DXGI bindings) as an optional dependency.

**P6 — Window resize verb + geometry getters. Impact 2 / Effort S.**
- Add `resize` and `set_bounds` to `WINDOW` action (`src/actions/window.ts:24`).
- Add `get_bounds`, `get_focused` returning `{ id, title, app, bounds, displayId }`.
- Wire into existing `setWindowBounds` (`src/platform/windows-list.ts:273`).

**P7 — Anthropic computer-use tool adapter. Impact 2 / Effort M.**
- New `src/actor/adapters/anthropic-cu.ts` translating Claude's `computer_20250124` actions (`key`, `type`, `mouse_move`, `left_click`, `left_click_drag`, `right_click`, `double_click`, `screenshot`, `cursor_position`) to `DesktopActionParams`. Register via existing `setActor` seam.

**P8 — MCP server surface. Impact 2 / Effort M.**
- New `src/routes/mcp-server.ts` registering tools that proxy to `ComputerUseService.executeCommand`. Mirrors cua's `mcp_server.py`. Allows external MCP-aware clients (Claude Desktop, Cline) to drive the same host.

**P9 — Set-of-Marks overlay + VLM grounding. Impact 2 / Effort M.**
- Extend `src/scene/scene-builder.ts` to optionally draw numbered marks over OCR/AX boxes on the captured frame and emit a `marks[]` table parallel to `Scene.ocr/ax`. Feed into Brain prompts as the cua/OmniParser stack does.

**P10 — Trajectory exporter. Impact 3 / Effort S.**
- New `src/actor/trajectory.ts` writing OSWorld/Windows-Arena-format JSONL to a configurable directory; hook into the existing `logger.info(evt: "computeruse.agent.step")` call sites in `src/actions/use-computer-agent.ts`.

**P11 — Windows Sandbox provider. Impact 3 / Effort L.**
- New `src/sandbox/windows-sandbox.ts` that templates a `.wsb` file, launches WSB, and exposes the same `ComputerUseService` surface over a local TCP/MCP bridge inside the sandbox. Parallel for macOS Lume/QEMU and Linux Docker is a separate L-effort each.

**P12 — Benchmarks. Impact 3 / Effort M each.**
- ScreenSpot adapter in `src/osworld/` (rename folder to `src/benchmarks/`); Windows-Arena adapter.

## 6. Concrete first patch suggestion (smallest, highest-value)

1. `src/platform/windows-list.ts:556-559` — replace `Stop-Process` with `PostMessage WM_CLOSE`. Same file `:210-226` — switch to `EnumWindows`/HWND ids.
2. `src/platform/nut-driver.ts` — add `nutGetCursorPosition`, `nutMouseDown`, `nutMouseUp`, `nutKeyDown`, `nutKeyUp` wrappers around existing primitives.
3. `src/services/computer-use-service.ts:324` — add `mouse_down`/`mouse_up`/`key_down`/`key_up`/`get_cursor` cases.
4. `src/actions/use-computer.ts:125-139` — add the four verbs to the `enum`.
5. New `src/platform/clipboard.ts` + service hookup + action enum entry.
6. `src/scene/a11y-provider.ts:396-444` — replace shallow walk with full `TreeWalker.ControlViewWalker` traversal, emit AutomationId/ControlType.

That set alone closes ~70% of the surface-level gap on Windows without touching the agent loop or sandbox story. Subsequent work is mostly additive (MCP, SoM, sandbox modes) and doesn't conflict.
