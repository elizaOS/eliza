# Tails comparison

> Status: living document. Updated as Phase 1 imports specific Tails
> components into `third-party/tails/`.

[Tails](https://tails.net) is the spiritual ancestor of usbeliza for
live-USB mechanics. We borrow battle-tested code where it makes sense
(locked decision #22) and diverge where our product purpose is different.

## What we share with Tails

- **Live-USB-first posture.** Both boot off a USB and don't touch the host
  disk. See `safety.md`.
- **Encrypted persistence on the USB itself.** Both use a LUKS-encrypted
  partition (`sdX3` in our layout) with a first-boot passphrase prompt.
- **Read-only base image with an overlay upper layer in RAM.** Same
  guarantee: writes evaporate unless persisted.
- **Debian-derivative built with `live-build`.** Same toolchain, same
  package universe.
- **Defense-in-depth sandboxing.** Tails uses AppArmor; we use bubblewrap
  per-app + per-app cap-bus sockets + AppArmor as a baseline (locked
  decision #14, plus the Tails-derived AppArmor profiles in Phase 1).

## What we take directly from Tails (Phase 1 imports)

These land under `third-party/tails/` keeping their GPL-3.0-or-later
header. See `NOTICE.md` for per-file provenance once imported.

| Component | Used for | Effort saved |
|---|---|---|
| `tails-persistence-setup` | LUKS partition setup wizard for `sdX3` | ~3 days |
| `tails-persistence-setup-helper` | per-feature persistence toggles | ~2 days |
| `live-additional-software` | persistent apt packages on encrypted partition | ~3 days |
| AppArmor profile baseline | defense-in-depth alongside bubblewrap | ~3 days |
| Plymouth theme | boot-splash starting point | ~1 day |
| `unsafe-browser` patterns | captive-portal handling | ~2 days |
| Tor Launcher / `tca` (Phase 2) | optional `/mode private` infrastructure | ~5 days |

## Where we diverge

- **Anonymity is not the primary product.** Tails optimizes for
  untraceable internet use. usbeliza optimizes for AI-native OS UX
  (chat-as-desktop, on-demand app generation, *Her*-style first boot).
  Tor in usbeliza is opt-in (`/mode private`), not default.
- **No Tor Browser.** We use Chromium-embedded for generated apps and the
  system WebView for the Eliza shell. The Tor case is handled at the
  shell-traffic level when private mode is on, not via a browser bundle.
- **Greeter is replaced by conversation.** Tails' GTK Greeter is
  pre-boot config. Ours is the Her-inspired calibration flow that runs
  inside the shell, after splash, with the local Llama 1B already loaded
  to handle the conversation.
- **AI-native architecture.** usbeliza ships `@elizaos/agent`, a bundled
  Llama 1B, and the codegen plugin that drives `claude --print`. None of
  this is in Tails' problem space.
- **Generated-app security model.** Our per-app cap-bus + bubblewrap +
  per-capability seccomp model is built for handling LLM-generated code
  as untrusted-by-default. Tails doesn't have an equivalent because Tails
  doesn't generate apps.

## License posture

- **Apache-2.0** for *our* code (every file outside `third-party/tails/`).
- **GPL-3.0-or-later** for Tails-derived code (every file inside
  `third-party/tails/`).
- The **combined live ISO is GPL-3 in distributable form**, matching
  Tails' own posture. This is intentional and team-approved (locked
  decision #22).

The license-header CI gate in `scripts/check-license-headers.sh`
enforces the per-directory split. Both license bodies live in
`LICENSES/`. Per-file provenance lives in `NOTICE.md`.

## Recommended further reading

- [Tails design documents](https://tails.net/contribute/design/)
- [Tails persistent storage](https://tails.net/doc/first_steps/persistence/)
- usbeliza `PLAN.md` "Tails relationship and license posture" section.
