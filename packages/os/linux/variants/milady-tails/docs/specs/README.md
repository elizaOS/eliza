# elizaOS Live implementation specs

File-level implementation plans for each phase of [`../../PLAN.md`](../../PLAN.md).
`PLAN.md` is the map (goals, success criteria, status); these specs are the
turn-by-turn directions (exact files, exact changes, ordered checklists).

Status note, 2026-05-16: Phase 2-7 OS/Tails overlays exist in source and
static smoke passes. A fresh full build + QEMU proof is still the gate for
calling the demo complete. Keep the specs as design/source-of-truth for
intent, and use `PLAN.md` for the current implementation status.

Each spec was produced by auditing the actual Tails source and the
milady/eliza app/runtime source, so they correct PLAN.md where the
original plan was imprecise (noted inline in each).

| Spec | Phase | Summary |
|---|---|---|
| [`phase-2-rebrand.md`](./phase-2-rebrand.md) | 2 | Rebrand Tails → elizaOS — greeter, boot menu, Plymouth, GNOME theme, wallpaper, os-release, issue; Tails credit preserved |
| [`phase-3-privacy-mode.md`](./phase-3-privacy-mode.md) | 3 | Boot-menu Tor on/off toggle — cmdline flag → firewall/Tor/resolv.conf branching |
| [`phase-4-bake-milady-app.md`](./phase-4-bake-milady-app.md) | 4 | Build the Milady Electrobun Linux app, bake it into the ISO via a chroot hook |
| [`phase-5-6-autolaunch-and-agent.md`](./phase-5-6-autolaunch-and-agent.md) | 5 & 6 | Auto-launch Milady as the desktop; wire the agent / onboarding / local LLM |
| [`phase-7-persistence.md`](./phase-7-persistence.md) | 7 | Persistent encrypted USB via Tails-native Persistent Storage (`tps`) |
| [`phase-8-mode-parity-harness.md`](./phase-8-mode-parity-harness.md) | 8 | The 4-combo QEMU mode-parity validation harness |
| [`phase-9-customization-actions.md`](./phase-9-customization-actions.md) | 9 | SHELL / SET_DESKTOP / THEME / NOTIFICATIONS chat actions |

All paths in the specs are relative to the variant's vendored Tails copy
unless noted: `packages/os/linux/variants/milady-tails/tails/`.
