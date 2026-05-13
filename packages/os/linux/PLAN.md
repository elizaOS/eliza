# ElizaOS USB — full plan

A USB-bootable AI-first operating system. Plug it into any compatible PC, boot, and the screen is a single chat box. There are no apps. There is no desktop, no taskbar, no file manager, no settings panel, no app drawer, no browser-as-application. The user asks Eliza for what they want; Eliza writes the app on the spot using the user's existing Claude Code or Codex subscription, and the app appears as a fullscreen window. Apps live in encrypted persistence on the same USB and reappear on demand.

This document is a planning artifact. No code yet.

---

## Status of foundational questions

**Is it a kernel fork?** No. It is a *Debian derivative* built with `live-build`. Same Linux kernel, same Debian repos, our custom shell + agent + toolchain layered on top. Same model as Ubuntu, Pop!_OS, Mint, Tails, Kali. A kernel fork is unnecessary maintenance debt for this product.

**Does it have full Linux shell access?**

| who | shell access | notes |
|---|---|---|
| Eliza agent | yes, sandboxed | runs `bash` inside its own bubblewrap profile; rm -rf the base image is denied; can read/write only its own data dirs and the active app's `src/` |
| The user | hidden by default, available on demand | `Ctrl+Alt+T` opens a bash terminal in a sandboxed window. `Ctrl+Alt+F2` drops to a real TTY. Default user never sees a shell |
| Generated apps | no exec | apps run in bubblewrap with declared capabilities only. They cannot exec arbitrary binaries; they call their own per-app cap-bus socket (`/run/eliza/cap-<slug>.sock`) to ask the agent to do shell-like things on their behalf |

**Does it run on ARM and Apple Silicon Macs?**

| target | bare-metal USB boot | as a VM | notes |
|---|---|---|---|
| x86_64 PCs from ~2012+ | ✅ primary product | ✅ via QEMU/VirtualBox | the main SKU |
| ARM laptops (Snapdragon X / Windows-on-ARM) | ✅ if BIOS allows USB-boot | ✅ via UTM/QEMU | separate `arm64` ISO, otherwise identical |
| Raspberry Pi 4/5 / ARM SBCs | ✅ same `arm64` ISO works | n/a | useful for kiosks, dev boards |
| Apple Silicon Macs (M1–M4) | ❌ Apple does not allow bare-metal boot of arbitrary OSes | ✅ via UTM (which uses Apple's own Hypervisor framework) | UTM is free, App Store available. The user double-clicks a `.utm` file we ship and it just opens. Not "plug USB and go" but it's the reality of Apple's lockdown |
| Intel Macs (any age) | ✅ x86_64 ISO works | ✅ | as old as 2008 — these are now cheap on the secondhand market |
| iPads / iPhones / Android phones | ❌ | ❌ | wrong product category — that's MiladyOS |

The honest answer to "every computer": **every x86_64 and ARM PC from the last ~12 years, plus Apple Silicon as a VM via UTM.** That covers ~95% of the world's general-purpose computing devices in 2026. The remaining 5% (bare-metal Apple Silicon) is an Apple policy decision, not a technical limitation we can solve without a multi-year reverse-engineering project (see: Asahi Linux).

We ship three artifacts:
- `usbeliza-amd64.iso` — primary live ISO
- `usbeliza-arm64.iso` — ARM live ISO (Pi, ARM laptops, ARM VMs)
- `usbeliza-mac.utm` — pre-baked UTM bundle wrapping the arm64 ISO for one-click install on Apple Silicon

---

## Locked decisions

These were open questions in earlier drafts. They are now decided. Any change requires explicit re-discussion — do not drift.

| # | Decision | Choice | Reason |
|---|---|---|---|
| 1 | Shell stack | **Tauri 2.x (Rust core, system WebView)** | Daemon-shaped binary, ~10 MB, smallest attack surface, cross-platform for the Phase 3 installers. Generated apps still get separately-spawned Chromium-embedded windows; the shell's own chrome uses the Tauri default WebView |
| 2 | Reuse vs. greenfield | **Reuse `@elizaos/agent` from day 1; reuse milady's llama loader recipe (zig cross-compile)** | Unified runtime across USB and phone (MiladyOS) means cross-device sync is mechanical, not a rewrite. Architecture mirrors milady: Tauri (Rust) UI talks HTTP to Bun-hosted agent subprocess on `127.0.0.1:41337` |
| 3 | VM test harness | **QEMU/KVM + libvirt + scripted (headless)** | Reproducible, snapshot-restore, CI-friendly, scriptable input via QMP/virtio-serial, screenshots via QEMU monitor. Same harness used in Phase 0 (run elizad in a VM) and Phase 1 (boot the actual ISO) |
| 4 | Repo & CI | **Private GitHub repo under `nubscarson`, Apache-2.0 license in-tree** | Personal account (not org). License committed for future-public discipline. CI on GitHub Actions. Secrets only via Actions secrets — never in repo |
| 5 | Persona | **Reuse the existing Eliza persona** from `eliza-labs-data/personal/system-prompts/eliza.txt` with a small OS-context preamble (`"I am the operating system. Ask me to build apps."`) | One voice across products. No second persona to maintain |
| 6 | Phase 0 target | **Headless QEMU VM from day 1** | The original PLAN's "run on a dev machine" still works, but pushing to a VM immediately catches sandbox/Wayland/permission bugs early and lets the same harness carry through to Phase 1 ISO testing |
| 7 | Generated-app WebView runtime | **Chromium-embedded** (separate from the shell's WebView) | AI-generated HTML is tested against Chromium; mismatched WebKit quirks waste rebuild attempts |
| 8 | Pre-warmed cache after first auth | calendar, notes, text editor, file viewer, clock, calculator | The PLAN.md set; six is the right size for the first-run feel |
| 9 | Capability v1 set | as listed under [Capabilities](#capabilities) below | Lock the v1 surface; v2 expansions go through a proposal review |
| 10 | `claude` and `codex` binaries | **Ship in base image** (refresh in updates, not on first auth) | Offline-boot guarantee. Base image grows by ~300 MB; worth it |
| 11 | License of generated apps | User-owned, no claim by us | Documented in first-run terms |
| 12 | Telemetry | Off by default, explicit opt-in language at first boot | Privacy posture is part of the brand |
| 13 | First-boot UX | **Conversational calibration (Her-inspired)** — Eliza asks 5 short personal questions before auth. Answers persisted to `~/.eliza/calibration.toml`, baked into her system prompt as a `<calibration>` block. Text-only for now; voice deferred until Shaw lands a model | First impression is a *presence*, not a setup wizard |
| 14 | Cap-bus isolation | **Per-app sockets** at `/run/eliza/cap-<slug>.sock`, bind-mounted into each bubblewrap. No shared `cap.sock` | Eliminates app-on-app impersonation on the cap bus |
| 15 | Splash chat boot | `elizad` accepts user input within ~5s of window appearing; queues messages until `eliza-agent` is ready, then replays | The "30s boot" in the PLAN is a UX target the architecture has to actively defend; agent cold-start would otherwise blow it |
| 16 | App version history | Rolling history of last 5 versions per app under `<slug>/.history/v{n}/`. Auto-rebuild critique loop bounded at 2 retries; failures surface a version picker with diffs so user can fork from a known-good version | "this is broken → rebuild" must converge or surface choice; no infinite-degradation loops |
| 17 | Top-bar affordance | Persistent thin status strip (device-mode, network/battery, hamburger → chat history, `/` → command palette). Toggleable, off-by-default after first ten minutes | Chat-only UX needs constant lightweight orientation cues — the user is never lost |
| 18 | Secure Boot strategy | Phase 1 files Linux Foundation shim review paperwork (does not block Phase 1 ISO build, just starts the months-long approval clock). Long-term: own Microsoft signing or stay shim-signed | Most modern Windows laptops ship Secure Boot enabled; users can't be expected to BIOS-tweak |
| 19 | Provider portability | The `trait CodeGenerator` boundary is locked. **Phase 1.5 adds a managed-proxy backend** — the cloud-sync subscription routes generation through our server using whichever provider works. Insurance against Anthropic/OpenAI ToS shifts | Sub-product becomes "you don't need a Pro/Max sub if you have ours" |
| 20 | MiladyOS-vs-usbeliza balance | **MiladyOS engineering does not pause for usbeliza.** Both ship as one story: USB is the awareness vehicle (zero hardware barrier demo), phone is the retention vehicle. Brand survives only if both are real | Diluting either kills the "one product, two form factors" thesis |
| 21 | Local Llama bundled in base image | **`Llama-3.2-1B-Instruct-Q4_K_M.gguf` (~600 MB) ships in the base image; loaded by `eliza-agent` at splash; primary chat handler before any cloud auth.** A larger 3B is downloaded to the encrypted partition on first network connect. | Pre-internet first-boot has to feel like *Her* — Eliza is *already there* talking to you, before you've connected to Wi-Fi. No blank-box wait |
| 22 | Tails-derived code is permitted | **`third-party/tails/` directory holds GPL-3.0-or-later code lifted from the Tails project** (`tails-persistence-setup`, NetworkManager helpers, AppArmor profiles, Plymouth theme). Combined live ISO is therefore GPL-3 in distributable form. Our own code outside `third-party/` stays Apache-2.0; combined-work license recorded in `NOTICE.md` | Licensing was cleared with the team. Saves ~14 days of from-scratch persistence/Tor/AppArmor work; matches Tails' battle-tested live-USB posture |
| 23 | `@elizaos/agent` is a real dependency from day 1 | **`bun add @elizaos/agent@alpha` lands in milestone 11a.** The agent boots eliza's runtime; `usbeliza-codegen` is restructured as a proper eliza plugin (`Action`); intent detection is replaced by eliza's planner. No more stub HTTP server | Stop LARPing the integration. Dogfood eliza, find its rough edges early, stay aligned with Shaw's ongoing pushes via the npm publish pipeline |
| 24 | Pre-internet system commands are deterministic | **Chat-commands like `connect to wifi`, `set my keyboard to <layout>`, `what time is it` are parsed by a regex/intent layer and dispatched to `nmcli`/`localectl`/`date` directly** — the local LLM never touches them | A 1B model hallucinates tool calls. The user must trust that "connect to wifi" actually connects, not "I tried to connect, here's a fake confirmation" |
| 25 | First-boot calibration adds 3 system questions | After the 5 personal questions: keyboard layout, language/locale, timezone — collected once, persisted to `~/.eliza/calibration.toml`, applied via `localectl` on every subsequent boot | The Her experience extends from "who are you" to "how does your computer work" — same conversational surface, no Settings panel anywhere |
| 26 | Live-USB never touches host disk | Host disk is read-only by construction: overlay-fs in RAM for the live root, LUKS persistence on `sdX3` of the USB itself. **Installing usbeliza to the host's internal disk is explicitly out of scope** until late Phase 5+ (with strong warnings) | Removes the entire class of "I tried it and it broke my system" risk. Tails' core safety guarantee, restated for ours |

---

## The user-facing experience

### First boot — the *Her*-inspired calibration

The reference is the OS1 install scene from Spike Jonze's *Her* (2013): not a setup wizard, a conversation. Eliza arrives as a presence, asks a handful of personal questions, and is calibrated to *this* user before she ever asks about cloud sign-ins or settings. Voice is deferred to a later phase (waiting on Shaw's model selection); the text-only version still has to feel warm.

The crucial design choice (locked decision #21): **Eliza is already there talking to you before Wi-Fi is connected.** A bundled local Llama-3.2-1B GGUF loads during splash and handles every conversation in this section — calibration, system setup, and the gentle teaching of how to connect to the network. The user only meets the cloud after they've met Eliza.

1. User plugs USB into a compatible machine, reboots, picks the USB from the boot menu (one-time firmware flick on most laptops).
2. ~30s boot — but the **splash chat** (locked decision #15) is up in ~5s. A soft fade-in from black; a single centered cursor; no logos, no progress bar. The local Llama 1B is already loaded; first reply latency is ~500 ms.
3. Eliza writes one line at a time, slow enough to feel deliberate:
   > *"Hi. I'm Eliza, the operating system on this stick. We have a moment to set up before we begin."*
4. **Five personal calibration questions** (locked decision #13), asked one at a time, free-text answers, all under ~30 seconds total:
   1. *"What should I call you?"*
   2. *"What do you spend most of your computer time on these days?"*
   3. *"Lots of tools at once, or just the one you need right now?"*
   4. *"Morning or evening person?"*
   5. *"When something I build for you doesn't work right, do you want me to fix it quietly, or tell you what I tried?"*
5. **Three system calibration questions** (locked decision #25), conversationally surfaced, not as a settings dialog:
   6. *"What keyboard layout do you use?"* (with a sensible default detected from `localectl`'s suggestion list)
   7. *"What language should I speak with you?"* (English default; offers detected locales)
   8. *"What timezone are you in?"* (auto-detected from IP if connected, else asked)
6. Answers persisted to `~/.eliza/calibration.toml` (encrypted partition once `sdX3` is unlocked; in-RAM until then); baked into Eliza's system prompt as a `<calibration>` block; applied to system state via `localectl` (keyboard, language) and `timedatectl` (timezone).
7. **Eliza teaches the user how to come online** (locked decision #24 — these are *deterministic* command-parses, not LLM dispatch):
   > *"To work on more than what's on this stick, we need to be online. Tell me 'connect to wifi' when you're ready."*
   - `connect to wifi` → opens NetworkManager UI in a sandboxed window
   - `connect to wifi <name>` → headless `nmcli device wifi connect <name> --ask` flow with passphrase prompt in the chat
8. *Then* the auth offer (not before — the OS earns the right to ask):
   > *"One more thing — I can build apps for you using Claude or Codex if you have a subscription. Or we can stay local; I'll do my best with what's on the stick."*
9. User picks Claude → device-flow OAuth in a one-shot fullscreen sandboxed WebView → token stored in encrypted USB partition. (Fallback path if WebView mishandles a gnarly OAuth challenge: open the URL in a separately-spawned Chromium window with full chrome.)
10. After auth, Eliza offers exactly three contextual examples — drawn from the calibration answers, not a static strip:
    > *"Try me. You said you write a lot — I could build you a notes app. Or just talk."*

Suggestions disappear after the second user-initiated message. From here on, Claude/Codex handles heavy code generation; the local Llama remains the fallback when offline.

### Steady state

- *"show me my calendar"* → Eliza checks `~/.eliza/apps/calendar/`. Doesn't exist → background-spawns Claude Code with a generation brief → Claude Code returns a single-file calendar app + manifest → bubblewrap launches it fullscreen → user uses it → closes it.
- Tomorrow: *"open my calendar"* → cache hit on slug `calendar`, same code, same data, same window.
- *"add a dark theme to my calendar"* → Eliza re-spawns Claude Code with the existing `src/` and the change request → patched version replaces the previous → user's data survives.
- *"this calendar is broken"* → one-tap **rebuild** action that re-spawns Claude Code with a critique brief that includes the user's complaint.

### Power-user escapes

- `Ctrl+Alt+T` opens a bash terminal in a sandboxed window
- `Ctrl+Alt+F2` drops to a real TTY (full root, but writes go to overlay only — base image stays read-only)
- `Ctrl+Alt+Shift+R` resets the current app to a fresh generation
- `/` in the chat box: command palette ("/sandbox", "/persist", "/auth", "/mode", "/quit")

Everything else is a chat instruction.

---

## Architecture (what runs under the chat box)

The shell is a **two-process design** mirroring milady's proven Capacitor→Bun pattern: a Tauri Rust frontend (`elizad`) talks HTTP over `127.0.0.1:41337` to a Bun-hosted agent runtime (`eliza-agent`) consuming `@elizaos/agent`. This split lets us reuse the entire eliza runtime (memory, trajectory, plugin system, OAuth-broker endpoints, model defaults) without forcing the agent's TypeScript world into Rust FFI.

```
Layer                  Component                            Notes
──────────────────────────────────────────────────────────────────────────────
Boot                   GRUB → live Debian kernel            EFI + BIOS, secure-boot-friendly
Init                   systemd, single graphical target     no DM, no DE
Display                Wayland via sway with one-window     <50 line config; the chat box
                       config                                IS the desktop
Shell (UI)             elizad (Tauri 2.x, Rust)             chat UI, sandbox launcher,
                                                             per-app cap-bus broker, supervises
                                                             eliza-agent + child app windows.
                                                             Implements splash-chat: input
                                                             accepted within ~5s of window,
                                                             queued + replayed once agent ready
Agent runtime          eliza-agent (Bun subprocess)         hosts @elizaos/agent on
                                                             127.0.0.1:41337; reuses milady's
                                                             memory + trajectory + plugin model
Intent dispatch        Local Llama-3.2-3B-Q4_K_M via         "what does the user mean"
                       llama.cpp + plugin-aosp-local-        parsing, slug resolution, tiny edits;
                       inference recipe                      reused zig cross-compile from milady
Pre-internet conversation Local Llama-3.2-1B-Q4_K_M loaded     ~600 MB GGUF in the base image;
& fallback chat        via @elizaos/agent's local-inference  ~500 ms first reply; primary
                       plugin                                 chat handler before any cloud auth
Heavy code generation  usbeliza-codegen Action: spawns        the user's existing subscription;
                       claude / codex CLI subprocess         stream-json output; idle when not used
Deterministic chat-cmd Regex parser dispatches `connect      no LLM in the loop for tool
                       to wifi`, `set keyboard`, etc. to     dispatch — local 1B can't be
                       nmcli / localectl / timedatectl       trusted to handle command syntax
Sandbox                bubblewrap + cgroup v2 + per-cap      one profile per declared capability
                       seccomp                               (time, net, fs-scoped, etc)
App runtimes           WebView (chromium-embedded) | GTK4    chosen at generation time;
                       | terminal (xterm.js in a window)     manifest declares
Persistence            LUKS-encrypted ext4 on partition 3    apps, conversations, files,
                                                             larger downloaded models. Schema
                                                             reused from milady (~/.eliza/db.sqlite,
                                                             trajectories table)
Capability bus         Per-app Unix socket                   JSON-RPC; the only way apps can
                       /run/eliza/cap-<slug>.sock            touch anything outside themselves.
                                                             elizad creates one socket per running
                                                             app and bind-mounts ONLY that socket
                                                             into the app's bubblewrap, so the
                                                             socket path identifies the caller —
                                                             no app-on-app impersonation possible
Toolchains shipped     Python 3, Node 20, Bun, Rust, GTK4,   used silently to compile/run
                       WebKit, ffmpeg, sqlite, busybox       generated code
```

What's installed in the base image: kernel + firmware blobs + Wayland + sway + `elizad` (Tauri) + `eliza-agent` (Bun) + `@elizaos/agent` runtime + `usbeliza-codegen` plugin + llama.cpp + a single bundled GGUF + Claude Code binary + Codex binary + Python 3 + Node 20 + Bun + Rust toolchain + GTK4 + WebKit + bubblewrap. Approximately 6.5 GB.

What's NOT installed: any "app" the user might recognize. No Firefox, no VS Code, no LibreOffice, no media player, no clock, no calculator, no Files, no Settings. The agent generates those on demand if asked.

---

## How "the AI builds an app" actually works

When the user says *"show me my calendar"*:

1. Local Llama parses intent. Detects the verb (`open`/`show`) and the slug-like noun (`calendar`).
2. **Identity resolution**: hits `~/.eliza/apps/calendar/manifest.json`. If present, skip to step 5. If not, continue.
3. **Generation brief composed**:
   ```
   Build a calendar app for ElizaOS. Runtime: webview. Single index.html with
   inline CSS and JS. Use the storage:scoped capability for events. Use
   time:read for current time. Use notifications:write for reminders. Open
   one fullscreen window, modern dark theme, keyboard-navigable.
   ```
4. **Spawn Claude Code or Codex**. `claude --print --output-format stream-json --dangerously-skip-permissions <<<"$brief"`. Stream the assistant tokens back into Eliza's UI as a "generating…" indicator. Tool calls are routed through Eliza, not the host.
5. Generation lands as `~/.eliza/apps/calendar/{src/, manifest.json}`. Validation: parse manifest, syntax-check entry, reject if any declared capability is unknown.
6. **Sandbox launch**: bubblewrap with the manifest's declared capabilities. Mount `src/` read-only, `data/` read-write, and bind-mount only this app's per-app cap socket at `/run/eliza/cap-<slug>.sock` (locked decision #14). No network unless declared.
7. App appears as a fullscreen Wayland window. User uses it. Closing the window returns to the chat box.

Three honest realities about this:

- **You need cloud-grade code generation for the demo to land.** Llama-3.2-8B local cannot reliably write a working calendar app. Local Llama parses intent and does small edits. Claude Code or Codex writes the actual app.
- **Generated apps will fail sometimes.** The "rebuild" action must be one-tap and must include a critique back to the model.
- **App identity must survive across sessions and across rebuilds.** "Calendar" today and "Calendar" Thursday must be the same app with the same data. Slug-stable, source-replaceable, data-persistent.

---

## The dream world — Eliza builds the desktop itself

The "no install, only build" rule extends past apps. **There is no
default desktop.** No wallpaper. No taskbar. No clock-in-the-corner. No
volume slider. The user gets a single chat box on pure black — and then
asks Eliza for whatever they want on screen.

User: *"Make me a dark space wallpaper with little stars."*
Eliza generates an image (ImageMagick from a procedural brief, or Claude
when signed in produces SVG), saves to `~/.eliza/wallpapers/space.png`,
calls `swaymsg "output * bg ~/.eliza/wallpapers/space.png fill"`.
Wallpaper changes instantly. *"Want me to make it slower-twinkling?"*
She regenerates with a tweak.

User: *"Build me a thin taskbar at the top with the time, battery, and
network."*
Eliza generates an HTML app with `manifest.runtime: "panel-top"` — a
floating horizontal strip docked above all other windows. The launcher
honors the panel runtime: bubblewrap with the relevant capabilities
(`time:read`, `battery:read`, `network:read`), sway floats + positions
it via `for_window [app_id="<slug>"] floating enable, sticky enable,
resize set ... move ...`. Taskbar appears.

User: *"Put a little dock on the right side with shortcuts to my notes
and my calendar."*
Same pattern, `runtime: "panel-right"`, the dock app uses the
`agent:ask` capability to forward "open my notes" / "open my calendar"
to Eliza on click.

This is the difference between usbeliza and every other OS. Every
visible element on the screen came into being because the user asked
for it. Removing it is one chat command. Customizing it is another.
There is no Settings panel because there are no defaults to set — only
conversations with Eliza about what the user wants the computer to look
like next.

**Manifest runtime types (v1):**

| `runtime` value | What it produces |
|---|---|
| `webview` | A normal fullscreen sandboxed window (Chromium-embedded). The default for "build me a notes app". |
| `wallpaper` | A static image set as the sway background. Generated by ImageMagick or a real image model; saved under `~/.eliza/wallpapers/<slug>.png`. |
| `panel-top` / `panel-bottom` | A docked horizontal strip the height of its content. sway pins it above/below all other windows; not resizable; sticky across workspaces. |
| `panel-left` / `panel-right` | A docked vertical strip the width of its content. Same sway rules. |
| `dock` | A floating, position-anchored window (e.g., bottom-center) the user can drag. Useful for music-player-style controls. |
| `widget` | A small floating window that ignores focus. Used for ambient surfaces (e.g., a Pomodoro countdown). |

The launcher reads `manifest.runtime`, picks the right sway rule, and
the rest of the system doesn't care which mode an app uses.

**The line we hold:** none of this comes installed. The user types
*"give me a taskbar"* and Eliza builds it from scratch. We don't ship a
default Eliza-blessed taskbar. The whole point is that the surface is
generative — every element a user sees is a record of something they
once asked for, kept (or thrown away, or rebuilt) at their discretion.

---

## The "no install, only build" rule

Hold the line on this. It's the philosophical core.

- No `apt`, no `snap`, no `flatpak`, no Discover, no Software Center reachable from the user shell.
- The base image ships **toolchains and libraries**, never **applications**.
- The agent's only path to making something exist is: emit source → compile/interpret → sandbox-run.
- A "skill marketplace" of pre-written apps would violate the rule. **Don't build it.** Skills can be *templates the agent uses as starting points*, not ready-made executables.

This is the differentiator. It also caps the addressable scope, which is fine — pick your ground and stand on it.

---

## Connecting to Claude Code / Codex

Skipping a "rent expensive cloud API" surface entirely. Reuse the user's existing subscription.

### Claude Code

- Anthropic Pro/Max subscriptions include Claude Code at no per-token cost (it's bundled into the sub).
- ElizaOS ships the `claude` CLI binary in the base image (~150 MB Bun-bundled binary).
- First sign-in: Eliza spawns `claude /login` in a sandboxed child terminal, captures the device-flow URL, opens it in a one-shot fullscreen WebView, user logs in with their Anthropic credentials, token lands in `~/.eliza/auth/claude.json` on the encrypted partition.
- Generation calls: Eliza spawns `claude --print --output-format stream-json --dangerously-skip-permissions` with the brief on stdin, parses the streamed tool calls, applies them in the sandbox.

### Codex

- OpenAI Plus/Pro subscriptions include Codex CLI access.
- Same flow with the `codex` binary and OpenAI's device-flow OAuth.

### Local-only fallback

- If the user has neither subscription, ElizaOS uses Llama-3.2-3B locally for code generation.
- Honest: at 3B-Q4 the apps generated will be visibly weaker. The boot prompt should nudge users toward Claude/Codex for the demo-quality experience.

### Why not BYOK API?

- Forces the user to manage an API key + spend cap. Hostile to "plug USB and go."
- Subscriptions are how mainstream users buy AI in 2026. Lean on what they already pay for.
- Optional: support BYOK as an *advanced* setting accessible via `/auth byok` in the chat box, off by default.

---

## App lifecycle

Apps are not packages. They're agent-generated artifacts on the encrypted USB partition.

### Filesystem

```
~/.eliza/apps/<slug>/
├── manifest.json
├── src/             # generated code (HTML, JS, Python, etc)
└── data/            # user's data; sandbox-only writeable
```

### Manifest

```jsonc
{
  "slug": "calendar",
  "title": "Calendar",
  "intent": "show me my calendar",
  "runtime": "webview" | "gtk4" | "terminal",
  "entry": "src/index.html",
  "capabilities": ["time:read", "storage:scoped", "notifications:write"],
  "version": 3,
  "lastBuiltBy": "claude-code-2.x",
  "lastBuiltAt": "2026-05-10T08:00:00Z"
}
```

### Capabilities

Every capability is a JSON-RPC method exposed on the app's **per-app socket** at `/run/eliza/cap-<slug>.sock` (locked decision #14). `elizad` creates the socket when launching the app and bind-mounts *only that path* into the app's bubblewrap. The socket path itself identifies the caller — there is no cross-app cap-bus and no shared cap.sock to impersonate over. The bubblewrap sandbox prevents apps from accessing anything not declared. Capability set v1:

| capability | purpose |
|---|---|
| `time:read` | get current time / timezone |
| `storage:scoped` | read/write `<slug>/data/` only |
| `notifications:write` | post a desktop notification |
| `network:fetch` | HTTP(S) GET/POST with allowlist of hosts in manifest |
| `clipboard:read` / `:write` | clipboard ops |
| `files:open-dialog` | request the user to pick a file from outside the sandbox; user gets a confirm dialog |
| `agent:ask` | call back into Eliza with a sub-question; useful for in-app help |
| `media:play` | hand a local file or URL off to a media engine for playback |
| `print:emit` | output to a fake printer surface |

If an app needs a capability it didn't declare, it asks the user via Eliza, not the host.

### Lifecycle states

```
[absent] ──build──▶ [draft] ──validate──▶ [installed] ──launch──▶ [running]
                       │                       │                      │
                       │                       └─uninstall────────────┘
                       └────────discard───────────────[absent]
```

Validation steps for `draft → installed`:
- manifest schema valid
- declared capabilities all known
- entry file exists and parses
- a quick smoke-launch in a hidden sandbox doesn't crash within 3s

If validation fails, Eliza re-spawns the generator with a critique brief automatically (**two retries max**, locked decision #16). If both retries fail, Eliza surfaces *"couldn't build this — want me to try again with different details, or pick from a similar app I built before?"* and offers the version picker if any prior versions exist.

### Updates and patches

- *"add dark theme to my calendar"* → re-spawn generator with current `src/` + change brief → atomic swap to new `src/` + bump `version` → relaunch. `data/` untouched.
- **Atomic swaps with rolling history (locked decision #16):** write new code to `src.next/`, validate, then `mv src .history/v<old>` and `mv src.next src`. Keep the **last 5 versions** under `.history/`, oldest pruned automatically. `data/` is never touched by an update.
- **Critique-loop convergence rule:** when the user says *"this is broken"*, Eliza re-spawns the generator with the user's complaint as a critique brief. Auto-rebuild is **bounded at 2 retries**. If both fail validation or the user still says it's broken, Eliza surfaces a **version picker** showing the diffs between the last 5 versions and lets the user fork from a known-good one. No infinite-degradation loop.
- Rollback is one tap from the version picker, *or* via `Ctrl+Alt+Shift+R` (resets to the most recent fresh generation), *or* via the slash command `/rollback <slug>`.

---

## USB partition layout

```
sdX1   FAT32, 256 MB        EFI + GRUB
sdX2   ext4, ~6 GB, RO      base image (Debian + Wayland + Eliza + toolchains + 1 GGUF)
sdX3   LUKS+ext4, rest      user persistence: built apps, conversations, files,
                             larger downloaded models, OAuth tokens
```

- 32 GB USB minimum (USB 3.0+).
- Boot direct from `sdX2` mounted via overlayfs (writes go to RAM; survive only if explicitly persisted).
- `sdX3` mount-prompts for passphrase on first run after boot.
- Optional **amnesia mode**: skip the `sdX3` prompt, no persistence, pure ephemeral — useful at borrowed/airport machines.

---

## Network model

By default, Eliza shell has network. Generated apps don't, unless they declare `network:fetch` and pin allowlist hosts in their manifest. The capability bus adds a one-time confirmation dialog the first time an app actually tries to fetch.

No Tor by default — multi-GB model downloads over Tor are unworkable. **Optional "private mode"** in `/mode private` routes shell traffic through Tor. Apps lose `network:fetch` entirely in private mode (Tor + arbitrary code = bad combination).

---

## Security model

The principle: **the agent is trusted, generated apps are not**. Apps are arbitrary code from a hallucination-prone LLM and must be treated like browser JS — sandboxed by default.

- Base image: read-only on disk, integrity-verified on boot (dm-verity).
- Persistence: LUKS with passphrase; user can opt to use a YubiKey or hardware key in v2.
- Apps: bubblewrap + per-capability seccomp + cgroup memory/CPU caps; can't see other apps; can't write outside their `data/`; can't exec arbitrary binaries.
- **Cap-bus isolation:** per-app sockets at `/run/eliza/cap-<slug>.sock`, owned by `eliza:eliza` mode `0660`, bind-mounted singly into each bubblewrap (locked decision #14). The socket path identifies the caller. No shared cap.sock; no app-on-app impersonation surface.
- Eliza shell: gets full filesystem access *but only via* the per-app capability bus from apps, so an app can't trick Eliza into doing things outside the user's intent without a confirm dialog.
- IPC: all *cross-trust-boundary* IPC is Unix sockets only. The one TCP-on-loopback exception is `elizad ↔ eliza-agent` on `127.0.0.1:41337` (inherited from `@elizaos/agent`'s built-in HTTP server). Both processes run as the same user; no network listener is exposed beyond loopback. **Phase 1.5 migration target:** patch `@elizaos/agent` to support a Unix-socket transport upstream and remove the loopback dependency.
- OAuth tokens stored in encrypted persistence, decrypted into memory only when needed. OAuth WebView is sandboxed; if a flow demands chrome (CAPTCHAs, hardware-key prompts), fall back to a separately-spawned Chromium window with full address-bar visible so the user sees the origin.

---

## Safety: this won't break your computer

Live-USB mode is **the only mode for now** (locked decision #26). Concrete guarantees:

- The USB stick has its own GRUB + kernel + filesystem layout (`sdX1` EFI / `sdX2` read-only base / `sdX3` LUKS persistence). Booting it does not touch the host's internal disk.
- Live root is overlay-fs with the upper layer in **RAM**. Writes don't survive reboots unless they hit the LUKS partition on the USB itself.
- `Ctrl+Alt+F2` (TTY) drops to the same overlay — even root-shell writes evaporate on reboot unless persisted explicitly.
- Removing the USB and rebooting returns the user to their normal OS, untouched.

**Three real risk surfaces** the user is informed about up-front, in `README.md` and a first-boot disclaimer:

1. **BIOS boot-order may change persistently.** Some firmware treats "boot from USB" as a permanent setting until reverted in BIOS setup. Easy fix; we document.
2. **Secure Boot may need a one-time disable** until the LF-signed shim ships in Phase 5 (locked decision #18).
3. **An "install to host disk" mode would be different and risky.** It is **not in scope** for Phase 0–4 and only considered for late Phase 5+ with explicit warnings, multiple confirmation prompts, and a separate ISO target. Today's ISO has no such code path. The `README` says so loudly.

This is the same safety posture as Tails. A user running usbeliza on a borrowed laptop, an airport kiosk, or their own machine experiences zero risk to whatever is already installed.

---

## Tails relationship and license posture

Tails (`https://tails.net`) has spent over a decade building the live-USB experience we want to inherit. With licensing cleared by the team (locked decision #22), `third-party/tails/` is a permitted, GPL-3.0-or-later subdirectory in the repo for code lifted directly from upstream Tails.

### What we take from Tails (Phase 1)

| Tails component | Used for | Effort saved |
|---|---|---|
| `tails-persistence-setup` | LUKS partition setup wizard for `sdX3` | ~3 days |
| `tails-persistence-setup-helper` | per-feature persistence toggles (network connections, GPG keys, etc.) | ~2 days |
| `live-additional-software` | persistent apt packages on the encrypted partition | ~3 days |
| Plymouth theme | boot splash starting point | ~1 day |
| AppArmor profiles | defense-in-depth alongside our bubblewrap | ~3 days |
| `unsafe-browser` patterns | captive-portal handling | ~2 days |
| Tor Launcher / `tca` (deferred to Phase 2) | optional `/mode private` infrastructure | ~5 days |

### License posture

- **Apache-2.0** stays the license for *our* code — every file outside `third-party/tails/` keeps its `SPDX-License-Identifier: Apache-2.0` header.
- **GPL-3.0-or-later** governs `third-party/tails/**` — every file there keeps its upstream Tails GPL header verbatim.
- The **combined live ISO is GPL-3** in distributable form, because GPL is viral when statically linked and Tails-derived components are shipped together with the rest of the OS. This matches Tails' own posture.
- `NOTICE.md` at repo root documents every Tails-derived file, the upstream commit/version it was sourced from, and any modifications.
- CI's `scripts/check-license-headers.sh` enforces per-directory licensing (Apache outside `third-party/`, GPL inside).

### What we explicitly do *not* take

- Tails' opinionated Tor-everywhere posture. We default to clearnet; `/mode private` opts in.
- Tails' Tor Browser. We use Chromium-embedded for generated apps and the system WebView for the Eliza shell.
- Tails' GTK Greeter. Replaced by our Her-inspired conversational calibration (locked decision #13).

---

## Known hard problems and honest answers

1. **Latency.** "Build me a calendar" cold = LLM round-trip + compile + window-show. Realistic numbers:
   - Claude Code, simple app: 8–25 s
   - Codex, simple app: 6–20 s
   - Local Llama-3.2-3B: 30–120 s
   - Apps that hit cache: <1 s
   First-build is the demo. After that, the cache hides the cost. Pre-warm a small "common apps" cache on first boot (calendar, notes, text-editor, file-browser, simple-paint) by generating them in the background once Claude/Codex auth completes.

2. **The blank-box problem.** A blank chat box paralyzes non-tech users. The 3-suggestion strip on first boot is mandatory; show 3, let them pick or type, hide forever after the second exchange.

3. **The "I want a real app" pressure.** Some user will demand VLC, or Photoshop, or Slack. The principled answer is: *"this OS doesn't run pre-built apps; only ones it builds for you. I can build a video player, an image editor, or a chat client."* Quality won't match VLC. That's the trade-off this OS makes. Stand by it.

4. **Hardware diversity.** USB boot on random PCs is mostly fine but:
   - NVIDIA + Wayland is dicey → fall back to X11 + Xwayland on detected NVIDIA cards
   - Intel iGPU usually fine, occasional i915 quirks
   - AMD GPU very fine
   - Apple Silicon: VM only (UTM)
   - Secure Boot needs a one-time disable on most laptops; we can MS-sign or self-sign in v2 to skip this

5. **Bad-app blast radius.** A generated app can't escape the sandbox, but it can waste user time and feel buggy. The "rebuild" button is first-class. The rebuild prompt includes the user's complaint as a critique brief.

6. **Battery.** llama.cpp on CPU eats laptop battery. ~2–3hr on a thinkpad-class machine when actively generating. Idle is fine. Add a "/mode battery" that disables proactive cache pre-warming.

7. **Slow USB.** USB 2.0 is unusable for boot. Document USB 3.0+ as a hard requirement.

8. **First-run "boot from USB" friction.** Most non-tech users don't know how to enter a BIOS boot menu. v2 should ship a Windows-side `ElizaOS Installer.exe` and a macOS-side `ElizaOS Installer.app` that:
   - Download the latest ISO
   - Verify the signature
   - Write the ISO to the user's USB
   - Optionally reboot the host straight into it (Windows: bcdedit; macOS: Startup Disk + reboot)
   This kills 80% of the "but how do I boot from USB?" friction.

---

## Build order

### Phase 0 — proving the loop in QEMU (~3 weeks; 4 milestones)

Goal: prove that a Tauri chat box, talking to a Bun-hosted *real* `@elizaos/agent` on `127.0.0.1:41337`, with a bundled local Llama-3.2-1B handling pre-internet conversation, can drive `claude --print` to write an app that appears in a bubblewrap-sandboxed Chromium window — and prove it inside a scripted, reproducible QEMU VM.

#### Phase 0 — Milestone 0 (DONE)

- ✅ Repo scaffold under `nubscarson/usbeliza` (private). Apache-2.0; SPDX headers everywhere; CI green: rustfmt, clippy `-D warnings`, cargo test, bun typecheck, bun test, license-headers, gitleaks.
- ✅ Cargo workspace with `crates/{elizad, eliza-cap-bus, eliza-sandbox, eliza-types}` — every crate carries doctests and unit tests.
- ✅ Bun workspace under `agent/` with stub HTTP server on `127.0.0.1:41337` returning the locked `/api/status` shape.
- ✅ `Justfile` contract; GitHub Actions CI on every push.
- ✅ `vm/disk-base.qcow2` builds via mmdebstrap+virt-customize; boots headless under qemu-system-x86_64; SSH forward responds; screenshot capture works.
- ✅ `elizad`: Tauri shell with splash-chat boot path, agent supervisor (real Bun spawn + readiness probe + restart-on-crash), 5-question calibration flow, top-bar status strip.
- ✅ `agent`: chat handler + intent detector (build/open/chat) + real `usbeliza-codegen` plugin verified end-to-end with `claude --print --output-format json --json-schema=…` (calendar in 55s, valid manifest, ~11 KB self-contained HTML).

#### Phase 0 — Milestone 11a (DONE)

- ✅ `bun add @elizaos/agent@alpha @elizaos/core@alpha @elizaos/plugin-bootstrap@alpha`. Real dep, not LARP.
- ✅ Eliza `Character` defined at `agent/src/characters/eliza.ts` with the persona base + OS-context preamble; validated by `@elizaos/agent`'s `CharacterSchema` (Zod) at module load.
- ✅ `persona.ts` rebuilt around the validated character; appends the dynamic `<calibration>` block at runtime.
- ✅ CI updated: `node-gyp + build-essential` apt-installed in the bun job so `node-pty` (transitive dep) rebuilds cleanly.

#### Phase 0 — Milestone 11b (DONE)

- ✅ Ollama + Llama-3.2:1b bundled in the qcow2 via `vm/disk-base/mmdebstrap.recipe` + `vm/scripts/build-base.sh`. Systemd override pins `OLLAMA_HOST=127.0.0.1:11434` (loopback only). qcow2 grew to ~2.7 GB.
- ✅ `agent/src/providers/ollama.ts`: real Ollama HTTP client. `/api/chat` with stream=false, `OllamaError` discriminator, `isOllamaReachable()` 2s probe, 60s per-call timeout. 8 unit tests covering all error codes via mocked fetch.
- ✅ `agent/src/chat.ts` plain-chat fallthrough now calls `ollamaCompleteOneShot(systemPrompt, message)`. Build/open intents still go through Claude Code (1B can't reliably write apps).
- ✅ End-to-end smoke verified: with Ollama serving the bundled model, the chat handler returned `"I am Eliza, a personal operating system for a single-user desktop application."` — persona transmitted through the local model.

#### Phase 0 — Milestone 11c (DONE)

- ✅ `eliza_sandbox::launcher::build()`: real `bwrap` argv builder. Namespacing (--die-with-parent --unshare-{user,pid,ipc,uts,cgroup-try} --new-session). --unshare-net unless `network:fetch` granted. /usr + /lib + browser-needed /etc bits ro-bound; /proc + /dev + tmpfs /tmp; per-app src/ ro and data/ rw; per-app cap socket bind (locked decision #14). Wayland socket ro-bound. clearenv + safe defaults. uid/gid 1000 in fresh user namespace. chromium --no-sandbox --ozone-platform=wayland --app file:///app/<entry>. Path-traversal in entry neutralized. 8 unit tests.
- ✅ `eliza_cap_bus::server`: real per-app JSON-RPC broker. `spawn(ServerConfig)` returns a `ServerHandle` whose Drop unlinks the socket. `time:read` returns `{epoch_ms, epoch_secs, iso8601_utc, tz}`. `storage:scoped` supports `read/write/list/delete` with strict key validation (no .., no /, no NUL, no leading .). Ungranted/not-implemented dispatch. 6 integration tests.
- ✅ `elizad`'s `launch_app(slug)` Tauri command: reads `~/.eliza/apps/<slug>/manifest.json`, validates, spawns cap-bus, builds bwrap, spawns the bubblewrap'd child. Per-app `LaunchRegistry` tracks (cap-handle, child) for clean shutdown.
- ✅ `chat` Tauri command now forwards the agent's full structured response (instead of extracting `.reply`); the UI reacts to `ChatResponse.launch` by `invoke('launch_app', { slug })`.
- ✅ All Phase 0 Rust + Bun tests still pass: 39 + 39 = 78. clippy -D warnings clean. fmt clean.

#### Phase 0 — Milestone 11a — Real `@elizaos/agent` (2–3 days)

- `bun add @elizaos/agent@alpha @elizaos/core@alpha` (Shaw's freshest publish).
- Define an Eliza `Character` based on `eliza-labs-data/personal/system-prompts/eliza.txt` + OS-context preamble + dynamic `<calibration>` block from `~/.eliza/calibration.toml`.
- Boot `eliza.runtime` in `agent/src/main.ts`. Replace the regex-based `intent.ts` with eliza's planner.
- Restructure `usbeliza-codegen` as an `@elizaos/agent` `Action` plugin (not a standalone module).
- Wire local-inference plugin (existing eliza desktop variant, or a thin port of `@elizaos/plugin-aosp-local-inference`).
- `/api/chat` becomes a thin wrapper around `runtime.processMessage(...)`.
- **Pass criterion:** all 28 agent tests still green; one new integration test does a real round-trip through eliza's runtime to the codegen Action.

#### Phase 0 — Milestone 11b — Local Llama in the qcow2 (1–2 days)

- Bundle `Llama-3.2-1B-Instruct-Q4_K_M.gguf` (~600 MB) into `vm/disk-base/overlay/usr/share/usbeliza/models/`.
- Install `llama.cpp` (apt or precompiled binary) into the qcow2 via virt-customize.
- Configure the eliza local-inference plugin to default to this model on first boot — pre-internet.
- Deterministic chat-command parser for `connect to wifi`, `set my keyboard to <layout>`, `what time is it`, etc., dispatched to `nmcli` / `localectl` / `date` / `timedatectl`. The local LLM never touches these (locked decision #24).
- Add the 3 system calibration questions (keyboard / language / timezone) to the existing 5-question flow.
- **Pass criterion:** boot the qcow2 with networking *disabled*; type `hi` in the chat box; get a coherent reply within 2 s; complete the 8-question calibration; state changes apply via `localectl --status`.

#### Phase 0 — Milestone 11c — Bubblewrap launcher + cap-bus broker + first calendar window (2–3 days)

- `eliza-sandbox`: real bubblewrap profile builder. Input: parsed `Manifest` + per-app cap socket path. Output: a `bwrap` invocation that mounts `src/` read-only, `data/` read-write, and bind-mounts ONLY this app's `/run/eliza/cap-<slug>.sock`. Per-capability seccomp profiles for v1 (`time:read`, `storage:scoped` minimum).
- `eliza-cap-bus`: real broker. Per-app sockets at `/run/eliza/cap-<slug>.sock`, owned `eliza:eliza` mode `0660`. JSON-RPC handlers for `time:read` (returns RFC 3339 + IANA timezone) and `storage:scoped` (read/write under the app's `data/`).
- `elizad`: `launch_app(slug)` Tauri command. Looks up the manifest, validates via `eliza-sandbox`, opens the per-app cap socket, spawns a bubblewrap'd `chromium-browser --app=file://...` (or `google-chrome` fallback) pointing at the entry file.
- UI reacts to the `launch` field in the chat response by invoking `launch_app`.
- **Pass criterion:** type `build me a calendar` in the chat; ~55 s later the calendar opens as its own fullscreen Wayland window inside the VM; today is highlighted; clicking a day persists a note via `storage:scoped`; closing the window returns to the chat.

#### Phase 0 — Milestone 11d (DONE 2026-05-10)

**`just vm-test` is green end-to-end.** All five canonical scenarios run in
one boot inside the qcow2: calendar → notes → text-editor → clock →
calculator. Each posts the intent to the in-VM agent via SSH-curl, gets a
structured reply with the launch hint, lands `manifest.json` +
`src/index.html` under `~/.eliza/apps/<slug>/`, the manifest's `slug` +
`schema_version` validate, and a QMP screenshot is captured.

Code-side pieces are landed; the full vm-test smoke is what verifies them
end-to-end inside the qcow2. As of the latest commits:

**Done (unit/integration level):**
- ✅ `eliza_cap_bus::tests::two_apps_cannot_read_each_others_storage` — proves
  the per-app data_dir isolation that locked decision #14 commits to.
- ✅ `eliza_sandbox::tests::bad_manifests` — five fixture JSON files
  rejected at parse-time (missing field, unknown capability, unknown
  runtime) or validate-time (bad slug, future schema_version).
- ✅ `usbeliza-codegen` critique-loop bounded at `MAX_AUTO_RETRIES = 2`
  with a feedback brief; tested with a flaky-spawn fake that fails N
  times then succeeds — verified converges on attempt N+1 ≤ 3, gives up
  beyond.
- ✅ `vm/scripts/run-tests.sh` drives all five canonical scenarios in
  one boot: calendar → notes → text-editor → clock → calculator.
- ✅ qcow2 with Ollama + Llama-3.2:1b + chromium + bubblewrap + wtype +
  grim + python3 + the in-VM input listener systemd unit + the
  per-host SSH harness key in `eliza`'s `authorized_keys`.

**Verification: ✅ done.**
- `just vm-test` GREEN. All five canonical scenarios produce manifest +
  entry on disk; manifests validate at content-level (slug match +
  schema_version=1); QMP screenshot captured.
- The smoke uses the codegen stub path (`USBELIZA_CODEGEN_STUB=1`) since
  the qcow2 doesn't carry Anthropic credentials — the real
  `claude --print` codegen is verified on the host (calendar in 55s)
  and via mocked-spawn unit tests. The orchestration chain (intent →
  codegen → manifest validate → disk write) is the same in both paths.

**Still ahead (post-Phase-0 polish, not blocking 11d):**
- Wire `just vm-test` into a nightly GitHub Actions job. Currently empty
  `.github/workflows/nightly.yml` — qcow2 builds take ~15 min and need
  KVM, so this needs a self-hosted runner.
- Bare-metal Wayland sandbox enforcement test (cat /etc/shadow denied /
  write outside data/ denied / exec /bin/sh denied) using the actual
  bubblewrap'd chromium against a deliberately-malicious test app. The
  argv builder's flags are correct by construction; this is end-to-end
  verification.

**Out of scope for Phase 0:** Codex backend, OAuth flows for cloud auth, network capability for generated apps (`network:fetch`), LUKS persistence on `sdX3`, ARM build, Mac UTM bundle, the live-build ISO, voice TTS. All deferred to Phase 1+.

### Phase 1 — USB live ISO with Tails-derived persistence (in flight 2026-05-11)

Goal: the demo USB. Same software stack the Phase 0 qcow2 carries, but produced via Debian's `live-build` so it boots bare-metal off a USB stick. Encrypted persistence via Tails-derived tooling. Wi-Fi, keyboard, and locale exposed through the existing calibration flow.

**Phase 1 — done (2026-05-11):**

- `live-build/` config tree (`auto/{config,build,clean}`, `config/package-lists`, `config/hooks/normal`, `config/includes.chroot_after_packages`) modelled on Tails' layout, adapted for live-build 20250814.
- `--linux-flavours amd64` — the FULL Debian kernel ships `virtio-gpu.ko` + `bochsdrm.ko`, so the QEMU GUI demo and bare-metal Wayland both render. (The cloud kernel in the Phase 0 qcow2 had zero DRM modules — that was the QEMU GUI blocker; live ISO sidesteps it entirely.)
- `0500-usbeliza-systemd.hook.chroot` — applies the Tails `52-update-systemd-units` masking pattern (`*-wait-online.service`, `systemd-networkd`, `getty@tty1`) so `multi-user.target` reaches in ~7s instead of timing out for 2 min.
- `0510-usbeliza-runtimes.hook.chroot` — installs Bun system-wide + Ollama + pulls Llama-3.2:1b into the squashfs so the ISO is fully offline-capable on first boot.
- Eliza Plymouth theme (wordmark + pulsing dot + LUKS password prompt) and branded GRUB drop-in mirror Phase 0's qcow2.
- **Encrypted persistence** via live-boot's built-in LUKS probe (`persistence persistence-encryption=luks,none` in bootappend-live). `usbeliza-persistence-setup` is a shell helper that creates a LUKS container on `sdX3`, formats ext4, writes `persistence.conf` declaring what survives reboots:
  - `~/.eliza/` (generated apps + their state)
  - `~/.ollama/` (downloaded models)
  - `/var/cache/apt/archives` (apt overlay)
  - `/etc/NetworkManager/system-connections` (saved wifi passwords)
  - `/etc/ssh` (host keys)
- **NetworkManager wrapper** (locked decision #24). New intent types in `agent/src/intent.ts` and `nmcli` shellout in `agent/src/network.ts`:
  - `list wifi networks` → wifi-list
  - `connect to wifi <SSID> password <pw>` → wifi-connect
  - `am i online` / `network status` → network-status
- 102 unit + integration tests green (57 Bun + 45 Rust).
- Justfile targets: `just iso-build`, `just iso-boot` (QEMU with virtio-gpu-gl), `just iso-usb /dev/sdX` (dd to USB), `just iso-clean`.

**Phase 1 — pending:**
- `just iso-build` first full run-through to completion (currently in flight; ~15 min wall time).
- QEMU boot of the freshly-built ISO — verify chat box renders, agent responds, "build me a calendar" works inside the ISO's GUI.
- USB write + bare-metal boot test on real hardware.
- Custom GRUB background PNG (Eliza-branded splash beyond the cosmetic drop-in).
- Reproducible builds via SOURCE_DATE_EPOCH gating like Tails does.

**Tails-derived shortcuts** (locked decision #22; under `third-party/tails/`, GPL-3.0-or-later):

- `tails-persistence-setup` — LUKS partition wizard for `sdX3`. First-boot prompt happens *after* the calibration flow finishes; calibration-RAM contents migrate to the encrypted partition once unlocked.
- `tails-persistence-setup-helper` — per-feature persistence toggles (network connections, OAuth tokens, downloaded models, generated apps).
- `live-additional-software` — persistent apt packages on `sdX3` so the user can `apt install` once and have it survive reboots.
- AppArmor profile baseline (defense-in-depth alongside our bubblewrap).
- Plymouth theme as a starting point for our brand splash.

**New code we still write** (Apache-2.0):

- `live-build` config tree under `live-build/` (auto/, config/, hooks/, etc.). Debian stable + minimal kernel + firmware + Wayland + sway + `elizad` + `eliza-agent` + `@elizaos/agent` runtime + bundled Llama 1B + bundled Claude binary + bundled Codex binary + bubblewrap + the toolchains (Python 3, Node 20, Bun, Rust, GTK4, WebKit).
- One-window sway config; no DM, no DE.
- OAuth flows for Claude and Codex tested end-to-end, with the chrome-fallback path for gnarly device flows.
- Wi-Fi + keyboard + locale + timezone applied from the calibration flow on every boot via `nmcli` / `localectl` / `timedatectl`.
- **Secure Boot lead-time (locked decision #18):** file the Linux Foundation shim review paperwork at the start of Phase 1. Does not block the Phase 1 ISO; the ISO ships unsigned and documents "disable Secure Boot" for now. The clock starts here so the LF-signed shim can land in Phase 4 or 5.

**Pass criteria:**

- Write the ISO to a USB, plug into 3 different machines (Intel laptop, AMD desktop, Pi 4), boot, complete calibration, connect to Wi-Fi via the chat, sign in to Claude, build a calendar, close, reboot, reopen calendar, data preserved.
- LUKS persistence: passphrase set on first boot, prompted on subsequent boots, calibration + apps + OAuth tokens all survive.
- Hardware diversity: NVIDIA falls back to X11+Xwayland cleanly; Intel iGPU + AMD GPU both run on Wayland; verify on at least one machine of each GPU vendor.
- Pre-internet Llama-1B chat works from a fresh boot with networking explicitly disabled.

### Phase 1.5 — managed-proxy code generation (~2 weeks, runs in parallel with Phase 2)

Goal: insurance against Anthropic / OpenAI ToS shifts that could throttle or break the `claude` / `codex` CLI flow. Also unlocks a third revenue line (BYOK-free generation for users without Pro/Max subs).

- Add a `ManagedProxy` impl of `trait CodeGenerator` (alongside `Claude`, `Codex`, `LocalLlama`)
- Cloud-side: a thin API server that authenticates the user's cloud-sync subscription and streams generation through whichever provider works (Anthropic, OpenAI, or our own model serving). Origin requests are signed by the user's per-device key; no plaintext bearer flows over the wire
- Client-side `/auth proxy` enables it; appears as a third option in the calibration step #6 ("Use my cloud-sync subscription instead of Claude/Codex")
- Pass criterion: with `claude` and `codex` both removed from the base image, the five canonical apps still build via the proxy backend
- Pass criterion: a server-side outage of a single upstream provider does not take down generation — the proxy fails over to the next provider transparently

### Phase 2 — ARM and macOS-VM SKUs (~2 weeks)

Goal: cover the long tail of devices.

- `usbeliza-arm64.iso` from the same live-build config with arch swap
- Test on Pi 4, Pi 5, a Snapdragon Windows laptop, an ARM SBC
- `usbeliza-mac.utm` bundle: pre-built UTM VM with the arm64 ISO
- Pass criterion: each variant boots and the calendar demo works

### Phase 3 — friction removal (~3 weeks)

Goal: make non-tech users able to use it.

- `ElizaOS Installer.exe` for Windows; `.app` for macOS — write USB, reboot into ISO
- Pre-warm cache on first boot (calendar/notes/editor/clock/calc) so the demo is instant after auth
- "Rebuild" first-class affordance with critique brief
- Onboarding: 3-suggestion strip, hide after second exchange
- Crash recovery: if a generated app crashes 3x in a row, auto-rebuild from scratch with a critique brief
- Pass criterion: a non-tech user, given a USB and a one-page card, can boot and build a working calendar inside 5 minutes

### Phase 4 — polish and demo content (~2 weeks)

- Plymouth boot splash with brand
- Wayland one-window theme polish
- A short "first run" film (10s) introducing Eliza
- Five canonical demo apps with curated quality (calendar, notes, paint, file-browser, text-editor) — these are the "this OS works" proof
- Documentation: a one-page card, a 5-minute YouTube demo, a developer reference for the capability API

### Phase 5 — distribution (~ongoing)

- Sign the ISO with a project key
- **LF-signed UEFI shim lands** (paperwork filed in Phase 1, locked decision #18). ISOs from Phase 5 onward boot on stock Secure Boot machines without BIOS gymnastics
- Auto-update channel (apt repo for the Eliza shell + agent components, base ISO refresh quarterly)
- Bug-report pipeline (Eliza opens a fullscreen GitHub issue composer)
- Telemetry: opt-in only, default off
- Hardware-compatibility tracker: a public list of tested machines with pass/fail per phase; community-contributed reports gated on a smoke-test report payload

---

## Distribution and business

**Sell USB at cost** as a consumable product (≈$15-25). Brand-printed 32 GB stick with the ISO pre-flashed. Solves the "boot from USB" learning problem for non-tech buyers — they don't need to know what an ISO is.

**Three revenue lines**:
- ISO + USB sales (low margin, brand reach)
- Optional cloud sync subscription: end-to-end encrypted backup of `~/.eliza/apps/` and conversations across devices, $5–10/mo. The shell, the local agent, the generated-app architecture all stay free and open.
- B2B: pre-loaded USBs for security/research/journalism use cases where amnesia mode + airgapped work is a feature

**Open-source posture**: Eliza shell, capability bus, sandbox profiles, build configs, manifest spec — all open. Closed: cloud sync server, the curated branding/assets, optional managed model serving.

---

## What this beats

- **Apple Intelligence**: vendor-locked, walled garden, can't run locally on your terms
- **Windows Copilot**: bolted-on chat sidebar in an ad-soaked OS
- **ChromeOS + Gemini**: pre-defined web apps; can't extend without Google
- **Linux + Ollama**: chat app on top of a normal distro; no OS-level integration
- **Tails**: privacy story is good, but Tor + AI is unworkable for app generation

The thing nobody else can ship: **an OS with no pre-existing apps, where everything you need materializes on demand**. Apple can't because they need an App Store. Microsoft can't because they need Office. Google can't because they need ad surfaces. We can because we start from zero.

---

## Risks and how to handle them

| risk | mitigation |
|---|---|
| First demo fails: generated calendar crashes | pre-warmed cache of 5 vetted apps; rebuild button; **two-retry auto-rebuild + version picker fallback** (locked decision #16) |
| User has no Claude/Codex sub | local Llama-3.2-3B fallback; degraded but functional; clear messaging that Claude/Codex unlocks better apps. **Phase 1.5 managed proxy gives a third path** (cloud-sync sub instead of Pro/Max) |
| Anthropic/OpenAI ban Claude Code/Codex from being driven by another shell | `trait CodeGenerator` is provider-agnostic; **Phase 1.5 ships a managed proxy** (locked decision #19) so users without Pro/Max — and us, if Anthropic flips a switch — can keep generating |
| Hallucinated app deletes user data | sandbox makes this impossible; per-app `data/` is the only writeable area; rolling 5-version `.history/` lets the user fork from a known-good version |
| Hallucinated app impersonates another app on the cap-bus | impossible by construction — per-app cap socket bind-mounted singly, the path identifies the caller (locked decision #14) |
| Boot is too slow; demo dies in the 30s wait | splash-chat accepts input within 5s, replays once agent is ready (locked decision #15) |
| OAuth flow needs CAPTCHA / hardware key the sandboxed WebView can't render | fallback path opens the OAuth URL in a separately-spawned Chromium with full chrome (address bar visible for origin verification) |
| Apple Silicon adoption pressure | UTM bundle covers it as a VM; Apple's policy, not ours |
| Battery drain when user is offline | `/mode battery` disables pre-warm; forces *cloud-only* generation (Tor + arbitrary code = bad combo, but cloud generation is fast and CPU-cheap on the client) |
| Secure Boot blocks first-time non-tech users | Phase 1 starts the LF shim paperwork clock; Phase 5 ships the LF-signed shim |
| Open-source competitors copy this | the differentiator is *execution quality* + *brand* + *phone+desktop synergy*; ship faster, ship better, never let MiladyOS or usbeliza fall behind the other |
| Competitive window closes (browser-as-OS, Anthropic ships its own desktop) | velocity. Phase 0–5 scoped at ~14 weeks; the moat is timing, not features |

---

## Relationship to MiladyOS phone

MiladyOS (the Pixel-targeted AOSP build, already in development) and ElizaOS USB share:

- The same Eliza agent runtime (`@elizaos/agent` from npm)
- The same local Llama loader (the AOSP llama.cpp work, recipe reused)
- The same persistence schema for apps and conversations
- The same calibration profile (`~/.eliza/calibration.toml`) — synced cross-device via cloud-sync subscription, so a user's Eliza calibrates the same on phone and USB
- Cross-device sync via the optional cloud subscription

**MiladyOS engineering does not pause for usbeliza** (locked decision #20). Both ship as one story; the brand depends on both being real. usbeliza is the awareness vehicle (zero hardware barrier; demo runs on a friend's laptop), MiladyOS is the retention vehicle (daily phone use). Diverting all engineering to one would dilute the thesis. Keep the teams parallel; share commits at the runtime layer.

Together they form **one product across two form factors**:
- **MiladyOS** is the phone — the long-term moat (replaces dialer, SMS, browser, home)
- **ElizaOS USB** is the desktop trial vehicle and the marketing demo (boots on any PC, shows the magic in 30 s, doesn't require buying hardware)

Lead the brand with the phone; use the USB as the demo. Or vice versa — but they ship together as a positioning story.

---

## Open questions

All resolved — see [Locked decisions](#locked-decisions) at the top of this document.

---

End of plan. Next step is Phase 0 — the QEMU-hosted loop-proof. See `AGENTS.md` for the operational SOP (build, test, iterate).
