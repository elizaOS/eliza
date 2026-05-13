# AGENTS.md — usbeliza build & test SOP

This file is the operational guide for any AI agent (Claude Code, Codex, etc.) working in this repo. Read it before touching code. The strategic vision lives in [`PLAN.md`](./PLAN.md). This document is *how to build it without producing slop*.

---

## What this project is, in one sentence

**usbeliza** is a Debian-derivative live-USB operating system whose entire UI is a single chat box (`elizad`, Tauri/Rust) that talks to a Bun-hosted `@elizaos/agent` runtime which generates apps on demand by spawning `claude` / `codex` CLIs, validates them, sandboxes them with bubblewrap, and shows them as fullscreen Wayland windows.

If anything in this repo conflicts with that sentence, the repo is wrong.

---

## Hard rules (non-negotiable)

These come from the user's standing feedback. Violating them produces work that gets rejected.

1. **One root cause → one targeted fix.** No bandaid hacks. No "in case" defensive code. No `// TODO`s left in committed code. No commented-out alternatives. No feature flags for hypothetical futures.
2. **Verify the build actually contains the fix.** Past mistake: a milady APK was built from `develop` while the fix was on a feature branch and "verified" was claimed without grepping the bundled JS for the fix marker. Before reporting any phase or test as passing, grep the actual artifact for the change.
3. **No AI slop.** Don't generate empty docstrings, throwaway comments restating the code, "best-practice" boilerplate that nobody asked for, or 38-line block comments. Comments explain *why*, not *what*. Default to no comment.
4. **Don't push without explicit go-ahead.** Local commits are fine; `git push`, `gh pr create`, `gh repo create`, etc. all require the user to say "go." This applies even to the private repo on `nubscarson`.
5. **Production-grade from commit #1.** Public-or-private, every commit passes CI: `rustfmt`, `clippy -D warnings`, `cargo test`, `bun test`, license-check.
6. **No destructive shortcuts.** `--no-verify`, `git reset --hard`, `rm -rf` of unfamiliar paths, `git push --force`: these all need explicit user approval per-use, not blanket pre-authorization.
7. **Don't restart shared state without asking.** A parallel agent may be running on `miladyserver`/`openclaw` VPS. Don't kill milady processes you don't own. (See `vps_milady_server` memory.)
8. **Match milady conventions where they overlap.** We reuse `@elizaos/agent`, the memory schema, the trajectory log, the persona files. Don't invent parallel structures for things milady already solved.
9. **Tails-derived code lives under `third-party/tails/` and stays GPL-3.0-or-later.** Every file there keeps its upstream Tails license header verbatim. New code outside that directory is Apache-2.0. The combined live ISO is GPL-3 in distributable form (matches Tails). Document every Tails-derived file in `NOTICE.md`. The license-header CI gate enforces this per-directory split — do not bypass it.

---

## Locked decisions

Pulled from `PLAN.md` — keep this in sync if `PLAN.md` changes. Any decision change requires user discussion, not unilateral re-architecture.

| # | Topic | Choice |
|---|---|---|
| 1 | Shell stack | Tauri 2.x, Rust core |
| 2 | Agent runtime | Reuse `@elizaos/agent` from npm; Bun subprocess on `127.0.0.1:41337` |
| 3 | VM test harness | QEMU/KVM + libvirt + scripted; headless; snapshot-restore between runs |
| 4 | Repo & CI | Private GitHub `nubscarson/usbeliza`; Apache-2.0 in-tree; GitHub Actions |
| 5 | Persona | Eliza (`eliza-labs-data/personal/system-prompts/eliza.txt`) + OS-context preamble |
| 6 | Phase 0 target | Headless QEMU |
| 7 | Generated-app WebView | Chromium-embedded (separate from Tauri's WebView for the shell UI) |
| 8 | Cache pre-warm | calendar, notes, text editor, file viewer, clock, calculator |
| 9 | Capability v1 | `time:read`, `storage:scoped`, `notifications:write`, `network:fetch` (allowlist), `clipboard:read`/`:write`, `files:open-dialog`, `agent:ask`, `media:play`, `print:emit` |
| 10 | `claude` / `codex` binaries | Ship in base image |
| 11 | Generated-app license | User-owned |
| 12 | Telemetry | Off; opt-in only |
| 13 | First-boot UX | **Conversational calibration** (Her-inspired). 5 personal questions before auth. Persisted to `~/.eliza/calibration.toml`. Text-only until Shaw lands a TTS model |
| 14 | Cap-bus isolation | **Per-app sockets** at `/run/eliza/cap-<slug>.sock`. Bind-mounted singly into each bubblewrap. No shared `cap.sock` |
| 15 | Splash chat boot | `elizad` accepts input within ~5s; queues until `eliza-agent` is ready, then replays |
| 16 | App version history | Rolling `<slug>/.history/v{n}/`, last 5 versions kept. Auto-rebuild bounded at 2 retries; failure surfaces a version picker with diffs |
| 17 | Top-bar affordance | Persistent thin status strip; auto-hides after 10 minutes; `Ctrl+Alt+/` to reveal |
| 18 | Secure Boot | Phase 1 files LF shim review paperwork; Phase 5 ships LF-signed shim |
| 19 | Provider portability | `trait CodeGenerator` is the boundary. Phase 1.5 adds a `ManagedProxy` backend (cloud-sync sub routes through our server) |
| 20 | MiladyOS balance | Engineering on MiladyOS does not pause for usbeliza. Both ship as one story |
| 21 | Local Llama in base | Llama-3.2-1B GGUF (~600 MB) bundled in qcow2 / ISO; loaded by `eliza-agent` at splash; primary handler before any cloud auth |
| 22 | Tails code OK | `third-party/tails/**` GPL-3.0-or-later; rest Apache-2.0; combined ISO is GPL-3; `NOTICE.md` documents every derived file |
| 23 | Real `@elizaos/agent` | `bun add @elizaos/agent@alpha` lands in milestone 11a — the agent boots eliza's runtime; codegen is a real plugin Action |
| 24 | Deterministic system commands | `connect to wifi`, `set keyboard`, etc. are regex-parsed and dispatched to nmcli/localectl/etc. directly — no LLM in the loop |
| 25 | Calibration adds 3 system questions | Keyboard / language / timezone collected once, applied via `localectl` on every boot |
| 26 | Live-USB only (no host install) | Host disk is read-only by construction. Install-to-disk is explicitly out of scope until late Phase 5+ with strong warnings |

---

## Repo layout (target — to be scaffolded)

The repo at `/home/nubs/Git/iqlabs/usbeliza/` currently contains only `PLAN.md` and this file. Phase 0 begins by creating this scaffold (a single commit, after user approval):

```
usbeliza/
├── PLAN.md                          # strategic plan + locked decisions
├── AGENTS.md                        # this file
├── README.md                        # public-facing intro (kept tight; private repo for now)
├── LICENSE                          # Apache-2.0
├── Justfile                         # task runner; see "Daily dev loop"
├── rust-toolchain.toml              # pinned stable
├── .editorconfig
├── .gitignore                       # /target, /node_modules, /vm/disk-base.qcow2, /vm/snapshots, /tmp, .env*
├── .github/
│   └── workflows/
│       ├── ci.yml                   # lint + unit + integration on every push
│       └── nightly.yml              # rebuild qcow2 base image, full vm-test
│
├── crates/                          # Rust workspace
│   ├── Cargo.toml                   # workspace manifest
│   ├── elizad/                      # Tauri shell binary (chat UI, agent supervisor, sandbox launcher, cap-bus broker)
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── agent_supervisor.rs  # spawns + restarts eliza-agent (Bun)
│   │   │   ├── cap_bus.rs           # per-app /run/eliza/cap-<slug>.sock JSON-RPC server (one per running app)
│   │   │   ├── sandbox_launcher.rs  # spawns bubblewrap for a manifest
│   │   │   └── ui/                  # Vite-built frontend
│   │   └── ui/                      # frontend source (Tauri sidecar)
│   ├── eliza-cap-bus/               # per-app cap-bus protocol + handlers; spawns one socket per running app
│   ├── eliza-sandbox/               # bubblewrap profile builder + manifest validator + version-history manager
│   └── eliza-types/                 # shared types: Manifest, Capability, Brief, GenerationOutput, CalibrationProfile (TOML schema for ~/.eliza/calibration.toml). Every persisted type has a `schema_version: u32` field
│
├── agent/                           # Bun workspace (eliza-agent process)
│   ├── package.json
│   ├── bun.lockb
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.ts                  # boots @elizaos/agent on :41337 with our plugin
│   │   ├── persona.ts               # loads eliza.txt + OS preamble
│   │   └── plugins/
│   │       └── usbeliza-codegen/    # custom plugin: spawns claude/codex; emits manifest+src
│   │           ├── index.ts
│   │           └── actions/
│   │               ├── generate-app.ts
│   │               └── rebuild-app.ts
│   └── tests/
│
├── vm/                              # VM test harness (Phase 0 + reused in Phase 1)
│   ├── README.md
│   ├── disk-base/
│   │   ├── mmdebstrap.recipe        # build the base qcow2 declaratively
│   │   └── overlay/                 # files copied into the image (sway config, systemd units, eliza binaries)
│   ├── scripts/
│   │   ├── build-base.sh            # builds disk-base.qcow2 from mmdebstrap recipe
│   │   ├── boot.sh                  # qemu-system-x86_64 -snapshot -enable-kvm ...
│   │   ├── inject.py                # virtio-serial input + QMP screenshots + assertions
│   │   └── teardown.sh
│   └── snapshots/                   # gitignored
│
├── tests/
│   ├── integration/                 # Rust integration tests against running eliza-agent
│   ├── smoke/                       # the 5 canonical app intents (calendar, notes, editor, clock, calculator)
│   └── fixtures/                    # bad-manifest examples, expected screenshots
│
├── live-build/                      # Phase 1 only — Debian live-build config (empty in Phase 0)
│   └── README.md                    # "Populated in Phase 1; see PLAN.md"
│
├── third-party/                     # Per locked decision #22
│   └── tails/                       # GPL-3.0-or-later code lifted from upstream Tails
│       ├── persistence-setup/       # tails-persistence-setup port for sdX3 LUKS wizard
│       ├── apparmor/                # AppArmor profile baseline
│       ├── plymouth/                # Plymouth boot-splash starting point
│       └── README.md                # license note + upstream commit refs
│
├── NOTICE.md                        # documents Tails-derived files + their upstream provenance
│
├── LICENSES/                        # SPDX text bodies
│   ├── Apache-2.0.txt
│   └── GPL-3.0-or-later.txt
│
└── docs/
    ├── architecture.md              # detailed two-process architecture
    ├── manifest-spec.md             # JSON schema + examples
    ├── capability-spec.md           # JSON-RPC API for the per-app cap-bus + threat model
    ├── generation-brief-spec.md     # the prompt template fed to claude/codex
    ├── tails-comparison.md          # what we share with Tails / what differs
    └── safety.md                    # live-USB never touches host disk; risk surfaces
```

---

## Prerequisites & one-time setup

This dev machine is **Debian forky/sid**. Most prereqs are already present (verified 2026-05-10). What's still missing — install only when its phase requires it, not preemptively:

| Tool | Status | Required for | Install |
|---|---|---|---|
| `claude` 2.1.138 | ✅ installed | Phase 0 | already at `~/.local/bin/claude` |
| `bun` 1.3.8 | ✅ | Phase 0 | already at `~/.bun/bin/bun` |
| `node` 22.22.2 | ✅ | Phase 0 | already at `~/.nvm/versions/node/v22.22.2/bin/node` |
| `rustc` / `cargo` 1.95.0 | ✅ | Phase 0 | already at `~/.cargo/bin/` |
| `qemu-system-x86_64` | ✅ | Phase 0 | system |
| `bwrap` | ✅ | Phase 0 | system |
| `xorriso`, `grub-mkrescue` | ✅ | Phase 1 | system |
| `/dev/kvm`, kvm/libvirt groups | ✅ | Phase 0 | (already in groups) |
| `codex` | ❌ | Phase 1+ | `bun add -g @openai/codex-cli` (when Phase 1 starts) |
| `just` | ✅ via apt | Phase 0 | `sudo apt install just` — the recipe runner; the Justfile is the contract |
| `mmdebstrap` | ✅ via apt | Phase 0 | `sudo apt install mmdebstrap` (Phase 0 VM image build) |
| `libguestfs-tools` | ✅ via apt | Phase 0 | `sudo apt install libguestfs-tools` — virt-customize for qcow2 customization |
| `cloud-image-utils` | ✅ via apt | Phase 0 | `sudo apt install cloud-image-utils` — cloud-localds, cloud-init seed |
| `live-build`, `debootstrap` | ❌ | Phase 1 | `sudo apt install live-build debootstrap` |
| Tauri prereqs | ✅ via apt | Phase 0 | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` |
| `cargo-tauri` | ✅ | Phase 0 | `cargo install tauri-cli --version "^2.0"` |
| `clippy`, `rustfmt` | (rustup components) | Phase 0 | `rustup component add clippy rustfmt` |

**Verify `claude` is signed in** before any Phase 0 work:

```bash
claude --print "say hi" 2>&1 | head -5
# If this returns assistant text in 2-5s, signed in.
# If it asks to /login, run `claude /login` interactively.
```

---

## Daily dev loop (Phase 0)

After scaffold lands, every `just <target>` should Just Work. The Justfile is the contract.

```just
# crates/ + agent/ + vm/ all in one
default:
    @just --list

setup:                          # one-time after fresh clone
    rustup component add clippy rustfmt
    cargo install tauri-cli --version '^2.0'
    cd agent && bun install
    just vm-build-base

dev:                            # full dev stack on the host (NOT in VM) — fast iteration
    # tmux/zellij split: agent on left, elizad on right
    bun --cwd agent run dev &
    cargo tauri dev --manifest-path crates/elizad/Cargo.toml

dev-vm:                         # full dev stack INSIDE the VM — slower, catches sandbox bugs
    just vm-up
    just vm-deploy

lint:
    cargo fmt --all -- --check
    cargo clippy --all-targets --all-features -- -D warnings
    cd agent && bun run lint

test:                           # unit + integration on host
    cargo test --all
    cd agent && bun test

vm-build-base:                  # build the qcow2 base image (slow; cached)
    sudo vm/scripts/build-base.sh

vm-up:                          # boot a snapshot of the base image headless
    vm/scripts/boot.sh --headless --snapshot

vm-deploy:                      # rsync current crates/ + agent/ build artifacts into the running VM
    vm/scripts/deploy.sh

vm-test:                        # full integration: boot, build 5 canonical apps via claude, assert
    vm/scripts/boot.sh --headless --snapshot &
    vm/scripts/inject.py tests/smoke/all.scenario
    vm/scripts/teardown.sh

vm-down:
    vm/scripts/teardown.sh

ci:                             # what GitHub Actions runs
    just lint
    just test
    just vm-test
```

**The golden iteration cycle on Phase 0:**

1. Edit Rust code in `crates/elizad/src/` or TS in `agent/src/`.
2. `just dev` rebuilds and reloads. Tauri hot-reloads the UI; `bun --watch` reloads the agent.
3. Type into the chat box: `"build me a calendar"`. Watch streamed tokens. App should open in a sandboxed window.
4. Before committing: `just lint && just test`. Both must be green.
5. Before pushing or claiming a phase complete: `just vm-test`. Must boot inside QEMU and pass the 5 smoke scenarios.

---

## VM test harness — how to think about it

The harness exists to make "did this break?" answerable in 3 minutes by CI, not 30 minutes by a human clicking around.

**Architecture:**

- **Base image** (`vm/disk-base.qcow2`): a Debian sid qcow2 built declaratively from `vm/disk-base/mmdebstrap.recipe`. Contains the Linux kernel, sway, bubblewrap, Bun, the `claude` binary, and a copy of `elizad` + `eliza-agent`. Built once per day in CI; cached as an artifact.
- **Snapshots:** every `vm-up` boots `disk-base.qcow2` with `-snapshot` so writes don't persist. Test isolation is free.
- **Input:** `qemu-system-x86_64 -chardev socket,id=vinput,server,nowait -device virtio-serial-pci -device virtserialport,chardev=vinput`. `inject.py` writes "type:hello" / "click:Build" / "wait:30" / "screenshot" / "assert:file exists ~/.eliza/apps/calendar/manifest.json" commands to the socket; a small companion daemon inside the VM enacts them.
- **Output:** QMP socket for screenshots; a virtio-serial reverse channel for assertion results; SSH (during dev only, off in CI) for filesystem inspection.
- **Determinism:** `claude` calls **are not deterministic**, so smoke tests assert *behavior* (manifest exists, app window opens, Wayland surface gets a non-blank screenshot, no crash) — not exact output. Token-level snapshot tests are forbidden in this codebase.

**Why headless from day 1:** because if the harness needs a human to click "OK" on a dialog, it doesn't run in CI, which means it doesn't run, which means regressions slip in. The user has explicitly burned-once-shy-twice on "verified" claims that weren't verified.

---

## Phase 0 → Phase 1 handoff: USB flashing on this machine

The user wants to dual-boot this same Debian forky/sid box from a USB stick once Phase 1 is green. Phase 1 produces `usbeliza-amd64.iso` via `live-build`. Flashing procedure (Phase 1 — DO NOT do this in Phase 0):

```bash
# 1. Build the ISO
just iso-build         # to be added in Phase 1; uses live-build/

# 2. Verify the ISO actually contains current code (don't trust the build):
xorriso -indev out/usbeliza-amd64.iso -find / -name 'elizad' -exec lsdd
# expected: a path under /usr/bin/elizad with mtime matching this build

# 3. Identify the target USB:
lsblk -o NAME,SIZE,VENDOR,MODEL,TRAN,REMOVABLE | grep -E '(usb|REMOVABLE)'
# CRITICAL: confirm device with the user before writing. Wrong target = data loss.

# 4. Write (with explicit confirmation):
sudo dd if=out/usbeliza-amd64.iso of=/dev/sdX bs=4M conv=fsync status=progress
sync

# 5. Boot menu: F12 / F8 / Esc on this hardware (depends on BIOS); pick the USB.
```

**Pre-flight checklist before flashing:**
- [ ] `just vm-test` passes from a fresh clone on a CI runner (not just locally)
- [ ] `xorriso -indev out/usbeliza-amd64.iso -find / -name elizad` shows a recent mtime
- [ ] User has confirmed the target `/dev/sdX` (lsblk output reviewed together)
- [ ] User has snapshotted any data on the target USB they want to keep
- [ ] BIOS boot order tested via QEMU first (`qemu -drive if=virtio,file=/dev/sdX,format=raw,readonly=on -boot menu=on`)

---

## Quality gates (CI from commit #1)

`.github/workflows/ci.yml` runs on every push and PR:

| Gate | Command | Block on fail |
|---|---|---|
| Format | `cargo fmt --all -- --check` | yes |
| Lint (Rust) | `cargo clippy --all-targets --all-features -- -D warnings` | yes |
| Lint (TS) | `bun --cwd agent run lint` | yes |
| Unit (Rust) | `cargo test --all` | yes |
| Unit (TS) | `bun --cwd agent test` | yes |
| License headers | `./scripts/check-license-headers.sh` | yes |
| Integration | `just vm-test` (against cached qcow2) | yes |
| Secrets scan | `gitleaks detect` | yes |
| Bundle audit | `cargo audit` (Rust), `bun audit` (TS) | warn → block on CRITICAL |

`.github/workflows/nightly.yml` rebuilds the qcow2 base image and uploads it as an artifact for the next day's CI.

**No `--allow-warnings`, no `if: github.event_name != 'pull_request'`, no skipping flaky tests.** A test that flakes gets fixed or deleted.

---

## What NOT to build (per PLAN.md "no install, only build" rule)

- ❌ A skill marketplace, app store, or "discover apps" surface
- ❌ A package manager UI (`apt`, `flatpak`, `snap`) reachable from the chat
- ❌ Pre-installed apps that aren't generated on demand. The five pre-warmed cache apps are *generated by the agent at first-auth* — they are NOT shipped pre-baked in the ISO
- ❌ A settings panel beyond `/auth`, `/mode`, `/sandbox`, `/persist`, `/quit` slash commands
- ❌ Browser-as-application. If a user asks for "a browser", the agent generates a minimal Webview-based browser app on the spot
- ❌ Cross-process IPC over TCP loopback. Use Unix sockets only (Phase 0 violates this for the agent on :41337 — flagged for Phase 1.5 to migrate to a Unix socket once the upstream eliza HTTP server gets that option)

---

## Reference: directly relevant prior work in iqlabs

These are the files/repos to read before reinventing something:

| Topic | Where | Why |
|---|---|---|
| `@elizaos/agent` runtime API | `node_modules/@elizaos/agent` after `bun install` in `agent/` | This is the public API we consume |
| Eliza persona | `eliza-labs-data/personal/system-prompts/eliza.txt` | Phase 0 imports this verbatim + prepends OS preamble |
| Memory schema | `node_modules/@elizaos/core/src/memory.ts` | Reused by `eliza-agent` for conversation persistence |
| Trajectory log format | milady's `~/.milady/db.sqlite` `trajectories` table | Same schema; we just write to `~/.eliza/db.sqlite` instead |
| llama.cpp cross-compile recipe | `node_modules/@elizaos/app-core/scripts/aosp/compile-libllama.mjs` (after milady install) | Reused for Phase 2's local-Llama fallback |
| Capacitor → Bun pattern | `eliza-labs/milady/apps/app/` | Architectural template for Tauri → Bun in usbeliza |
| MiladyOS role-replacement | `eliza-labs/milady/os/android/vendor/milady/` | *Conceptual* reference for "chat IS the only UI" — we use sway WM config for the same effect |
| Capability gating shape | (does not exist yet anywhere — this is novel to usbeliza) | Design from scratch; document in `docs/capability-spec.md` |

---

## Glossary

- **`elizad`** — the Tauri/Rust shell process. Owns the chat UI, supervises `eliza-agent`, brokers the per-app cap-bus, launches sandboxed app windows.
- **`eliza-agent`** — the Bun/TS subprocess hosting `@elizaos/agent` on `127.0.0.1:41337`. The "brain" — handles conversations, plugin actions, code generation.
- **`usbeliza-codegen`** — our custom `@elizaos/agent` plugin. Exposes `generate-app` and `rebuild-app` actions that spawn `claude` / `codex` (or, in Phase 1.5+, the `ManagedProxy`) and emit `{src/, manifest.json}`.
- **cap-bus** — JSON-RPC over a **per-app Unix socket** at `/run/eliza/cap-<slug>.sock`. `elizad` creates one per running app and bind-mounts only that path into the app's bubblewrap. No shared `cap.sock`.
- **manifest** — the per-app `manifest.json` declaring slug, runtime, capabilities, version. The validator in `eliza-sandbox` enforces it.
- **calibration profile** — `~/.eliza/calibration.toml`, written on first boot from the 5-question conversational flow. Read by `eliza-agent` at startup; baked into the system prompt as a `<calibration>` block.
- **splash chat** — the input-accepting UI state in `elizad` between window appearance (~5s post-boot) and `eliza-agent` becoming ready. Messages typed during splash are FIFO-queued and replayed.
- **version history** — `<slug>/.history/v{n}/` directories holding the last 5 versions of an app's `src/`. Surfaced via the version picker when auto-rebuild fails or the user wants to fork.
- **base image** — the read-only Debian + toolchains layer on the live ISO (Phase 1+). In Phase 0, the equivalent is `vm/disk-base.qcow2`.
- **persistence partition** — LUKS+ext4 on `sdX3` of the live USB; holds `~/.eliza/`, OAuth tokens, downloaded models. In Phase 0, this is just `~/.eliza/` on the dev machine / VM.
- **canonical apps** — calendar, notes, text editor, file viewer, clock, calculator. Used as smoke tests in Phase 0; pre-warmed in cache after first-auth in Phase 3+.
- **`ManagedProxy`** — Phase 1.5 backend for `trait CodeGenerator`. Routes generation through our cloud-sync subscription server. Insurance against Anthropic / OpenAI ToS shifts.
- **LF shim** — Linux Foundation's pre-signed UEFI bootloader shim. We file paperwork in Phase 1, ship signed in Phase 5; lets unsigned ISOs boot on stock Secure Boot machines.
- **Local Llama** — `Llama-3.2-1B-Instruct-Q4_K_M.gguf`, ~600 MB, bundled in the base image; loaded by `eliza-agent` at splash via `@elizaos/agent`'s local-inference plugin; handles every chat before any cloud auth (locked decision #21).
- **Deterministic chat-command** — a regex-matched user message that dispatches to a system tool (`nmcli`, `localectl`, etc.) without going through the LLM. Used for `connect to wifi`, `set my keyboard to <layout>`, etc. (locked decision #24). The local 1B model is too small to be trusted with tool dispatch.
- **Tails-derived** — files lifted directly from the Tails project under `third-party/tails/`, staying GPL-3.0-or-later. Documented in `NOTICE.md`. License-header CI gate enforces the per-directory split.

---

## When in doubt

Ask. The user has been burned by autonomous agents marking work "done" that wasn't done, building from the wrong branch, and producing slop comments. A 30-second clarifying question is cheaper than a 30-minute wrong-direction sprint.
