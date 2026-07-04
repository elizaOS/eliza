# Electrobun Desktop — verification findings (ui-ux-polish lane)

Issue #12061 / PR #12062. Branch `feat/ui-ux-polish`. Verified on macOS (darwin
arm64), Electrobun 1.18.1, isolated stack: API `:31501`, renderer static server
`:5174`, `PGLITE_DATA_DIR=/tmp/lane-desktop-db`, `ELIZA_DEV_NO_WATCH=1`.

The renderer was built (`bun run --cwd packages/app build:web` — Vite build
succeeded, 431 assets, manifest written) and the desktop stack booted via
`bun run dev:desktop`. Verification used the loopback observability endpoints
(`GET /api/dev/stack`, `/api/dev/cursor-screenshot`, `/api/dev/console-log`)
plus Playwright attached to the Electrobun renderer static server (`:5174`,
discovered from the console log) — the same built renderer the native window
loads. `/api/dev/stack` reports `desktop.rendererUrl: null` in non-watch mode
(no Vite dev URL); the console log exposes the Electrobun static server URL,
which is what Playwright drove.

## 1. Main window / desktop main surface — GOOD (by design: chromeless overlay)

The desktop main window boots in **chat-overlay (bottom-bar) shell mode**, not a
mobile launcher grid:

    [Renderer:console] [shell] window shell mode: chat-overlay
      (search="?apiBase=...&shellMode=chat-overlay")
    [startup-coordinator] phase=ready

The main surface is decided in
`packages/app-core/platforms/electrobun/src/index.ts` -> `createMainWindow()`
via `resolveDesktopShellWindowPresentation()`: `kiosk` / `bottom-bar` / `full`.
The default shipped here is the **bottom-bar chat overlay** — a frameless,
transparent, always-on-top strip pinned to the screen bottom that renders the
chat shell (`resolveBottomBarFrame()`), i.e. the tray/chat-driven intent, **not**
a launcher-centric window. The `full` mode (1440x900 default frame, first-launch
maximized) renders the personal-assistant ambient home — clock, weather,
"Welcome — ask me anything to get started" with suggestion chips, and Tour /
Connect-calendar / Autonomy cards, plus a bottom composer
(`desktop-full-shell-home.png`). That is a chat-first home, again **not** a grid
of app icons. Product intent (tray/chat-driven, not launcher-centric) is met.

- `desktop-full-shell-home.png` — `full` shell ambient home (real renderer pixels).
- `desktop-app-menu-bar.png` — OS-level capture; the load-bearing signal is the
  live **Eliza-dev application menu bar** (`File Edit View Desktop Apps Views
  Window`). Note: `/api/dev/cursor-screenshot` is a **full-desktop** OS capture,
  and the developer machine was in concurrent personal use, so it is not a clean
  isolated window shot; the native main surface is the thin bottom-bar overlay,
  so there is no large "main window" to size-check in full-vs-overlay terms.

Window-size verdict: reasonable — overlay is a display-derived full-width bar;
`full` mode defaults to 1440x900 and maximizes on first launch. No tiny/huge
window observed.

## 2. Tray + application menu (rename landed) — GOOD

Asserted from source **and** the passing unit suites (built menus reflect it):

- `packages/app-core/src/runtime/desktop/tray-menu.ts` — `DESKTOP_TRAY_MENU_ITEMS`
  has `tray-open-chat` labelled **"Open Messages"** (`desktop.tray.openChat`), a
  **"Views"** submenu built from `DESKTOP_VIEW_WINDOWS` (Tutorial, Help,
  **Messages** (`/chat`), **Character**, **Knowledge** (`/character/documents`),
  **Settings**, **Background**), and a **"Notifications"** item
  (`tray-open-notifications`).
- `packages/app-core/platforms/electrobun/src/application-menu.ts` —
  `VIEW_MENU_ENTRIES` / `buildViewsMenu()` mirror the same list with the
  **Messages** rename; the live app menu bar shows the **Views** menu
  (`desktop-app-menu-bar.png`).
- Tests: `tray-menu.test.ts` 4/4 pass; `application-menu.test.ts` 10/10 pass
  (`desktop-menu-tests.txt`). A cross-file sync test keeps the renderer and
  bun-side view lists in lock-step.

## 3. Chat input on desktop — GOOD (real LLM cycle verified)

Drove the real composer (`[data-testid="chat-composer-textarea"]`) against the
live runtime. The message posts, the runtime accepts + processes it, and a real
model generates the reply. Full persisted thread
(`desktop-chat-thread-transcript.json`, screenshot
`desktop-chat-after-live-llm.png`):

| # | role | text |
|---|------|------|
| 1 | user | "...please reply with exactly one short sentence confirming you received this message." |
| 2 | assistant | "Something went wrong on my end. Please try again." (pre-fix, see blocker) |
| 3 | user | "...reply with exactly one short sentence confirming you received this." |
| 4 | assistant | **"I have received your message."** (correct one-sentence reply) |
| 5 | user | "Reply with only this exact code and nothing else: ZQ7X-VERIFY-4821" |
| 6 | assistant | **"ZQ7X-VERIFY-4821"** (14.1 s round-trip) |

Row 6 echoes a **unique token invented for this test** — it cannot come from
seeded history, so it proves a genuine end-to-end LLM cycle: composer -> runtime
(message `7f6d4f47...`, `source=client_chat`, `channelType=DM`) -> OpenAI-plugin
-> Cerebras `gemma-4-31b` -> reply. Backend log after the model fix shows **zero**
`Not Found` errors (`desktop-backend-log-excerpt.txt`).

Backend accepted the message every time (the `[CommunityInvestor] ... Message
content:{...}` line logs the exact text), so even the failed first send proves
the **post + runtime-accept** path works independently of the model.

- `desktop-chat-before.png` / `desktop-chat-typed.png` / `desktop-chat-after-live-llm.png`.

### Blocker encountered (resolved, environment-level — NOT a lane code defect)

On first boot the agent replied "Something went wrong on my end" because text
generation 404'd:

    [router] Provider openai failed for TEXT_SMALL; trying fallback provider (Not Found)
    [router] Provider openai failed for TEXT_LARGE; trying fallback provider (Not Found)

Root cause: the developer's **ambient** shell pointed `@elizaos/plugin-openai` at
the Cerebras OpenAI-compatible endpoint (`CEREBRAS_API_KEY` + Cerebras base URL)
while the OpenAI model ids in the environment were non-Cerebras names, so the
Cerebras endpoint returned 404 for the requested model; the local `llama.cpp`
fallback had no conversation GGUF staged (only the `gte-small` embedding model),
so no reply was generated. There is **no provider key in the worktree** (`.env`
absent — only `.env.example`); the Cerebras key is ambient. Resolution: restart
the isolated stack with an explicit served model
(`OPENAI_BASE_URL=https://api.cerebras.ai/v1`,
`OPENAI_{SMALL,MEDIUM,LARGE,NANO,RESPONSE_HANDLER}_MODEL=gemma-4-31b`,
`ELIZA_PROVIDER=cerebras`). `gemma-4-31b` is a served Cerebras model (verified
directly against `/v1/chat/completions`), after which the live replies above were
produced. The model-resolution default
(`DEFAULT_CEREBRAS_TEXT_MODEL="gemma-4-31b"` in
`packages/core/src/contracts/service-routing.ts`) is correct; the 404 came from
ambient `OPENAI_*_MODEL` overrides shadowing it, not from lane code.

## 4. Onboarding — GOOD (affordances present; full tour flow not driven)

The `full` desktop home (`desktop-full-shell-home.png`) is the onboarding
surface: greeting ("Good evening"), weather widget with an "Enable location"
prompt, "Welcome — ask me anything to get started" with quick-start chips
(What's left today? / What can you do? / Summarize my day / Dismiss), and
onboarding cards **Take the tour**, **Connect your calendar**, **Autonomy**.
On-brand (orange accent, no blue). The full guided-tour click-through was not
exercised in this lane; the entry points render and are reachable.

---

## Verdict summary

| Area | Verdict | Evidence |
|------|---------|----------|
| Main window / desktop main surface | GOOD (chromeless chat-overlay by design; full = chat-first ambient home, not a launcher grid) | desktop-full-shell-home.png, desktop-app-menu-bar.png, desktop-backend-log-excerpt.txt |
| Tray + application menu (Open Messages / Views / Notifications) | GOOD | tray-menu.ts, application-menu.ts, desktop-menu-tests.txt, desktop-app-menu-bar.png |
| Chat input (real LLM cycle) | GOOD | desktop-chat-after-live-llm.png, desktop-chat-thread-transcript.json, desktop-backend-log-excerpt.txt |
| Onboarding home | GOOD (affordances render; full tour not driven) | desktop-full-shell-home.png |

No source changes were required for this lane; the dev-platform wrapper fix
already landed on the branch. The one blocker was an ambient environment model
mismatch, resolved at runtime (see section 3).
