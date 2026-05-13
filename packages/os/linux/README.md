# usbeliza

A Debian-derivative live-USB operating system whose entire UI is a single chat box.
Plug it into any compatible PC, boot, and Eliza writes the apps you ask for on the
spot using your Claude Code or Codex subscription. No app store. No pre-installed
applications. The OS generates what you need on demand.

> **Status:** Phase 0 — proving the loop in QEMU. Milestones 0/11a/11b/11c
> done; 11d harness wired and rebuilding the qcow2. Not yet a usable
> product. See [`PLAN.md` Build order](./PLAN.md#build-order) for the full
> phase ladder and what's left.

## Documents

- [`PLAN.md`](./PLAN.md) — the strategic plan and locked decisions
- [`AGENTS.md`](./AGENTS.md) — operational SOP for any AI agent contributing here
- [`docs/safety.md`](./docs/safety.md) — guarantee that this won't break your computer
- [`docs/tails-comparison.md`](./docs/tails-comparison.md) — what we share with Tails / what differs
- [`NOTICE.md`](./NOTICE.md) — third-party derivations and license posture

## Quick links

- **License (own code):** Apache-2.0 — see [`LICENSE`](./LICENSE)
- **License (Tails-derived code):** GPL-3.0-or-later — under [`third-party/tails/`](./third-party/tails/), see [`NOTICE.md`](./NOTICE.md)
- **Combined live-ISO license (distributable form):** GPL-3, matching Tails' posture
- **Repository:** private during Phase 0; public from Phase 1 onward
- **Sister project:** [milady-ai/milady](https://github.com/milady-ai/milady) (the phone — MiladyOS)

## Will it break my computer?

**No.** Live-USB mode never modifies the host disk — boot off the USB, run as long as you like, remove the USB and reboot, and you're back on your normal OS untouched. The full safety story (risk surfaces, BIOS notes, Secure Boot) is in [`docs/safety.md`](./docs/safety.md).

## Architecture, in one diagram

```
elizad (Tauri / Rust)            ← chat UI, sandbox launcher, per-app cap-bus broker
   ↕ HTTP 127.0.0.1:41337
eliza-agent (Bun subprocess)     ← @elizaos/agent + usbeliza-codegen plugin
   ↕ spawns
claude / codex / managed-proxy   ← code-generation backends
```

See [`PLAN.md`](./PLAN.md#architecture-what-runs-under-the-chat-box) for the full layer breakdown.

## Repo layout

See [`AGENTS.md`](./AGENTS.md#repo-layout-target--to-be-scaffolded) for the canonical layout.

## Building

```sh
just setup       # one-time after fresh clone
just dev         # full dev stack on the host
just dev-vm      # full stack inside the QEMU harness
just lint        # rustfmt + clippy + bun lint
just test        # unit + integration tests on host
just vm-test     # integration via QEMU smoke scenarios
```

## Contributing

This project follows the SOP in [`AGENTS.md`](./AGENTS.md). The hard rules
(one-fix-one-cause, verify-the-build-contains-the-fix, no AI slop, no destructive
shortcuts, production-grade-from-commit-1) are non-negotiable.
