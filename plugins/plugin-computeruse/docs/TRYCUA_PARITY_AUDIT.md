# Computer-Use × Vision — trycua/cua parity audit (current state)

Authoritative, **current-state** review of where elizaOS `plugin-computeruse` +
`plugin-vision` stand against [trycua/cua](https://github.com/trycua/cua) and the
six other computer-use / OCR references, refreshed **after M3 / M3.5 / M4a / M5 /
M6 / M7 / M8** landed on `develop` (the older `reports/trycua-*.txt` snapshot
predates M7+M8 and is stale).

- Tracking issues: **#9105** (EPIC — integration) and **#9170** (parity + tests
  on Windows/Linux/macOS/AOSP).
- Test-lane reference: [`TEST_LANES_COMPUTERUSE_VISION.md`](./TEST_LANES_COMPUTERUSE_VISION.md).
- Raw research snapshots: `reports/cua-external-summary.txt`,
  `reports/trycua-matrix.txt`, `reports/trycua-gaps.txt`.

---

## 1. External-repo review (what to adopt, what is N/A)

| Repo | What it is | OCR | Local vision model | Continuous/low-token screen | Net takeaway for us |
|------|-----------|-----|--------------------|------------------------------|---------------------|
| **trycua/cua** | ~50-verb computer-server (WS/HTTP/MCP) over 6 VM/sandbox providers + agent SDK (loop registry, predict_step/predict_click, Set-of-Marks/OmniParser grounding, callback middleware) | model-side (hosted) | no | discrete capture→act loop | **The parity target.** Verb gaps are small/additive; the real work is the architecture: loop registry (M10), SoM overlay (M9), provider/RPC matrix (M13), eval harness (M14). |
| **coasty-ai/open-computer-use** (Apache-2.0) | OSS+SaaS CUA; web + Electron + MCP | classical (pytesseract, Linux VM only) | no (hosted "Coasty CUA") | discrete loop, JPEG q70, HD price penalty | **Adopt:** cross-platform input-correctness (DPI scale, off-primary cursor) — *already taken in M3.5*; predict/ground separation — *M5*; stateful session to cut tokens; avoid runtime-compiled inline C# in the PS fallback (AMSI fingerprint). |
| **injaneity/pi-computer-use** (MIT) | macOS-only; AX-tree grounding, **no vision/OCR** | none (AX tree + CDP) | none | pull-based AX snapshots | **Adopt:** accessibility-tree grounding tier to skip OCR for most clicks — *partially in scene a11y-provider*; stale-ref reacquisition; batched multi-action → one post-state; GET_SCREEN envelope with explicit scale/coordinateSpace/stateId. |
| **domdomegg/computer-use-mcp** (MIT) | thin local MCP mirror of Anthropic's computer-use tool | none (model does it) | none | pull-based, downscaled | **Adopt:** cursor-crosshair drawn into the frame; hard-cap to 1568px/~1.15MP + re-encode before any cloud model; validated bidirectional image↔logical scale; `xdotool --clearmodifiers`. |
| **vercel-labs/ai-sdk-computer-use** (no license — reference only) | Next.js demo, Claude drives a Vercel Sandbox | none | none (cloud Claude) | noVNC live for human; pull screenshots for model | **Adopt (patterns, not code):** `prunedMessages()` token-frugal history (redact prior frames, keep latest) — *aligns with M3 dHash + M11*; pull-based, skip re-screenshot after blind type/key; typed image tool-results; Anthropic `cacheControl` on the stable preamble; provider-defined-tool path when the model is Anthropic. |
| **bracesproul/gen-ui-computer-use** (MIT) | LangGraph Generative-UI showcase over OpenAI CUA + Scrapybara | none | none (OpenAI CUA) | hosted VNC iframe + per-action audit shots | **Adopt:** before/after action hooks streaming typed UI cards; clean live-view vs audit-trail split; content-addressed screenshot store (we already have the better sha256 media-store) + collapsed-by-default frames; live pause/approve/abort controls. |
| **baidu/Unlimited-OCR** (MIT) | one-shot long-horizon **document** OCR (DeepSeek-OCR + DeepSeek-V2 MoE, GGUF-able) | VLM end-to-end | yes (3B/0.5B-active) | n/a (batch doc parser) | **Adopt later:** a candidate **local** OCR/VLM for `plugin-vision` once exposed as GGUF — fits the "local, token-frugal" goal. **Not** a screen/CUA tool; document-parsing only. |

**Cross-cutting design conclusions already encoded in our roadmap:** OCR + element
detection belong in `plugin-vision` and feed `plugin-computeruse` through the
`CoordOcrProvider` seam (M1); screen understanding must be **local + token-frugal**
(GGUF only, no ONNX) with dHash-gated re-description (M3); a `GET_SCREEN` action
returns a typed image + structured elements (M2).

---

## 2. Verb / capability parity matrix (vs trycua/cua, on `develop` today)

Legend: ✅ have · 🟡 partial · ❌ missing · ⛔ N/A (deliberately not chased)

### Pointer / keyboard / screen (host drivers)
| trycua capability | elizaOS status | Where |
|---|---|---|
| screenshot (per-display, native res, quality/downscale) | ✅ | `platform/capture.ts`, `screenshot-quality.ts` |
| click / right_click / double_click | ✅ | `COMPUTER_USE` |
| **middle_click** | ✅ (M8) | `nut-driver.ts` `nutMiddleClick` |
| click_with_modifiers | ✅ | |
| mouse_move | ✅ | |
| **mouse_down / mouse_up** (button-param press-hold) | ✅ (M8) | `driver.ts` `driverMouseDown/Up(x,y,button)` |
| **key_down / key_up** (press-hold; bare modifiers) | ✅ (M8 + #9189) | `resolveKeyCode` now maps `MODIFIER_KEYS` |
| type / key / key_combo | ✅ | |
| scroll (per-notch + raw) | ✅ (M3.5 per-notch pacing = parity-plus) | |
| drag (start→end) | ✅ | |
| **drag (multi-point polyline path)** | ✅ (M8) | `driver.ts` `driverDragPath` → `nutDragPath`/`densifyDragPath` |
| get_cursor_position | ✅ (M3.5) | win32 uses `System.Windows.Forms.Cursor` (nutjs getPosition is stale) |
| get_screen_size / to_screen(shot)_coordinates | ✅ | multi-display + DPI transforms |
| get_environment / desktop info | 🟡 | `get_environment` yes; `get_desktop_environment` (for driver selection) ❌ minor |

### Vision / grounding
| trycua capability | elizaOS status | Where |
|---|---|---|
| **ocr** (full-screen, coord-bearing) | ✅ (M7) | `COMPUTER_USE ocr` → `getCoordOcrProvider()` (plugin-vision OCR) |
| **detect_elements** | ✅ (M7) | routes through scene element registry + CoordOcr |
| **GET_SCREEN action** (typed image + elements, token-frugal) | ✅ (M2) | `plugin-vision/src/get-screen.ts`, `get-screen-elements.ts` |
| low-token continuous description | ✅ (M3) | dHash-gated `DirtyTileDescriber` + frame-dHash skip + token counters |
| predict / ground split (cheap ground vs full predict) | 🟡 (M5) | `OcrCoordinateGroundingActor` + per-Scene grounding cache; no model-string registry yet |
| accessibility-tree grounding tier | ✅ | scene `a11y-provider` (Win UIA / macOS AX / Linux AT-SPI) |
| OmniParser/icon detection (GGUF, no ONNX) | 🟡 | `yolo-detector.ts` (YOLOv8n COCO GGUF via `native/yolo.cpp`) |
| **Set-of-Marks (numbered overlay) grounding** | ✅ (M9) | `plugin-vision/src/som.ts` + `set-of-marks-provider.ts`; registered via `registerSetOfMarksProvider` seam in `mobile/ocr-provider.ts` |

### Windows / files / process / shell
| trycua capability | elizaOS status | Where |
|---|---|---|
| window list/focus/switch/arrange/move/min/max/restore/close | ✅ | `WINDOW` action |
| get_current_window_id / get_application_windows(app) | ❌ (M12) | `scene.focused_window` is adjacent but no discrete getter verb |
| get_window_size / get_window_position / set_window_size | ❌ (M12) | `WINDOW_MOVE` sets position only |
| open(target) / launch(app,args)→pid | ❌ (M12) | |
| filesystem verbs (exists/list/read_text/write_text/read_bytes/write_bytes/delete/create_dir/get_file_size) | 🟡 (M12) | internal `file-ops.ts` + docker-backend wire ops; **not** exposed as `COMPUTER_USE` verbs |
| run_command (CommandResult) | 🟡 (M12) | `terminal.ts` one-shot + docker-backend; not a host `COMPUTER_USE` verb by design |
| PTY / interactive terminal | ❌ low-pri | one-shot only |
| clipboard read/write | ✅ (M3.5) | `CLIPBOARD` action |

### Architecture / platform
| trycua capability | elizaOS status | Notes |
|---|---|---|
| agent-loop registry (model-string → loop) | 🟡 (M10) | hardcoded Brain→Cascade→Actor→dispatch |
| callback middleware (budget/image-retention/trajectory/operator-normalize) | 🟡 (M11) | approval-manager + token counters + log-line trajectory events |
| VM/sandbox provider matrix | 🟡 (M13) | Docker backend only; WSB + QEMU are the opt-in targets worth adding |
| daemon/RPC seam (`{command,params}→{success,result}`) | ❌ (M13) | in-process service; routes only for approvals |
| MCP server seam | ❌ | one optional MCP seam is the relevant subset of cua's 2 servers / 35 tools |
| eval harness (ScreenSpot / OSWorld / GET-commands matrix) | 🟡 (M14) | `osworld/` adapter + `benchmarks/eliza-1/vision-cua-e2e`; not yet per-OS scenario-wired |
| AOSP touch + hardware keys + multitouch | 🟡 | Capacitor bridge tap/swipe + globalAction(back/home/recents); `multitouch_gesture` ❌ |

### Explicitly N/A (do not chase)
`set_wallpaper` (niche) · `playwright_exec` / `browser_execute` (**unconditionally
disabled**, GHSA-rcvr-766c-4phv) · cloud managed sandbox · the full 2-MCP-server /
35-driver-tool surface · PII anonymization · AOSP gRPC `:8554` backend (CI-only).

---

## 3. Test-coverage matrix (every-verb, by lane and platform)

Lanes: **unit** = default Vitest (runs on all OSes), **real** = `*.real.test.ts`
gated `platform()==="win32"` and excluded from the default run (Windows only),
**e2e**, **scenario** (scenario-runner / issue-evidence), **probe** = standalone
`bun` driver check.

| Capability group | unit (all OS) | Windows real/probe | Linux | macOS | AOSP |
|---|---|---|---|---|---|
| pointer click family + modifiers | `cua-parity-surface`, `computer-interface`, `dispatch`, `use-computer-action` | `cua-parity-input.real`, `computeruse.real`, `service.real`, probes | ⚠️ no real lane | ⚠️ no real lane | n/a |
| M8 middle/down-up + key down-up + drag-path | `cua-parity-surface`, `nut-driver-input` (incl. modifier guard) | `cua-parity-input.real` + this-session probe (**verified**) | ⚠️ no real lane | ⚠️ no real lane | n/a |
| ocr / detect_elements (M7) | `ocr-adapter-coord-seam`, `ocr-with-coords`, `computeruse-ocr-bridge` | `service.real`, OCR bridge | unit only | `ocr-service-apple-vision` (unit) | n/a |
| GET_SCREEN / scene / dHash (M2/M3) | `get-screen`, `get-screen-elements`, `dirty-tile-describer`, `screen-state`, `dhash`, `scene-*` | scene multimon/probe | unit only | unit only | `android-scene` |
| windows / clipboard / cursor | `platform-capabilities`, `windows-powershell-safety` (static) | `windows-list.real`, `clipboard` (win32), cursor probe | unit only | unit only | n/a |
| files / terminal | `security-file-target` | `file-ops.real`, `terminal.real` | unit only | unit only | n/a |
| OCR engines | `ocr-service`, `ocr-service-windows`, `yolo-detector` | `ocr-service-windows` (win32) | `ocr-service` (docTR) | `ocr-service-apple-vision` | n/a |
| autonomous loop | `cascade`, `brain`, `dispatch`, `computer-use-agent` | `computer-use-agent.real`, `runtime.live.e2e` | unit only | unit only | `mobile-cascade`, `aosp-input-actor` |
| benchmarks | `osworld-action-converter` | `benchmark/osworld-*.real` | — | — | — |
| approvals / progress | `computer-use-approval-relay` | `routes-e2e` | scenario `8912-computeruse-progress-approvals-*` | — | — |
| mobile/AOSP | — | — | — | — | `android-bridge`, `android-trajectory`, `ios-*`, device-evidence manifests |

### The single biggest "tests on all platforms" hole
The real-driver lane is **`win32`-only** (`const RUN = platform()==="win32"`). The
nutjs + legacy `xdotool`/`cliclick` code paths exist for Linux/macOS but **no
equivalent real-driver lane executes them** — and because the gate skips silently,
a Linux/macOS regression would not turn a lane red. This is exactly how the M8
`key_down("shift")` bug (fixed in #9189) reached `develop`: M8's real test was
authored on a host without a Windows machine, so the gated case never ran.

**Recommended (M14):** a Linux Xvfb headful lane and a macOS headful lane that run
the parity verbs against the real driver, plus a machine-checkable matrix derived
from the action enum so a newly-added trycua verb that lacks a per-OS test fails CI.

---

## 4. Per-platform verification status

| OS | Driver | Status |
|----|--------|--------|
| **Windows 11** | nutjs (default) + legacy PowerShell | **Primary, verified.** All M8 verbs + key_down modifier fix dispatched against the live desktop this cycle (cursor read back via WinForms). OCR via `Windows.Media.Ocr` (M4a). |
| **Linux** | nutjs + legacy `xdotool` (X11; AT-SPI/Wayland fallback) | Code paths present + unit-tested; **no real-driver lane runs** → needs Xvfb headful CI. Clipboard needs `wl-clipboard`/`xclip` (asserts clear error when absent). |
| **macOS** | nutjs + legacy `cliclick`; retina backing-store 2× transforms | Code paths present + unit-tested (incl. Apple Vision OCR); **no real-driver lane runs** → needs headful macOS CI; assert retina coordinate transforms. |
| **AOSP / Android** | Capacitor bridge + `MobileComputerInterface` | tap/swipe + globalAction(back/home/recents) implemented + unit-tested; device-evidence manifests exist; `multitouch_gesture` missing; system-app path is CI-only. |

---

## 5. Remaining roadmap (prioritized)

1. **M14 cross-platform real lanes** *(highest leverage for the stated goal)* —
   The enum-derived parity coverage guard (`cua-parity-coverage.test.ts`) is
   **landed** and runs on all platforms in the default lane, and the real lane is
   no longer win32-hardcoded. The remaining piece is the **Linux Xvfb + macOS
   headful CI lanes** that actually invoke the real config (requires a
   `.github/workflows/**` change / `workflow` token scope). Until those exist,
   real-driver *actuation* is verified on Windows only.
2. **M12 additive verbs** — window getters (`get_current_window_id`,
   `get_application_windows`, `get/set_window_size`, `get_window_position`),
   `open`/`launch`, and the filesystem/`run_command` verbs (wrap the existing
   internal `file-ops.ts`/`terminal.ts` as gated `COMPUTER_USE` verbs).
3. **M10 agent-loop registry** + predict_step/predict_click split (extend the Actor
   registry; keep approval gating).
4. **M11 callback middleware** — budget cap, image-retention (only-N-recent, aligns
   with M3), operator-normalizer, trajectory.
5. **M13 provider matrix + RPC seam** — Windows Sandbox (WSB) + QEMU behind a
   remote-guest `{command,params}→{success,result}` RPC over the route/WS seam.
6. **AOSP `multitouch_gesture`** (MT-Protocol-B) + an optional MCP server seam.

**Done since this audit was first written:** M9 Set-of-Marks (numbered-overlay
grounding) landed — `plugin-vision/src/som.ts` + `set-of-marks-provider.ts`,
registered via the `registerSetOfMarksProvider` seam; 23/23 unit tests green on
Windows.

> **Process note for contributors:** the `*.real.test.ts` lanes only execute on a
> Windows host. Before trusting any newly-landed computeruse milestone, run its
> verbs against the real driver on Windows (or the future Linux/macOS lanes) — a
> green default-lane run does **not** mean the platform paths work. See §3.
