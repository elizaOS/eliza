# Relationship to usbeliza

Both **usbeliza** (`packages/os/linux/`) and **milady-tails**
(`packages/os/linux/variants/milady-tails/`, this directory) are live-USB
Linux distributions built from the same agent framework. They differ in
how the user *experiences* the OS.

## The same primitives

Both consume:

- `@elizaos/core` — `AgentRuntime`, `Plugin`, `Action`, `Memory`, `ModelType`,
  `runtime.useModel`
- `@elizaos/agent` — `CharacterSchema`, `PROVIDER_PLUGIN_MAP` (inlined),
  the canonical plugin-collector pattern
- The same agent code patterns documented in
  `packages/os/linux/docs/eliza-integration.md`
- The same Rust crates for the capability broker
  (`packages/os/linux/crates/eliza-cap-bus/`), sandbox launcher
  (`packages/os/linux/crates/eliza-sandbox/`), and shared types
  (`packages/os/linux/crates/eliza-types/`)
- The same BUILD_APP / OPEN_APP / SET_WALLPAPER / WIFI / time actions
- The same notion of "the agent generates HTML apps on demand and the
  sandbox launcher runs them in a Chromium app-mode window with a
  capability bus"

## The session layer is different

| Aspect | usbeliza | milady-tails |
|---|---|---|
| **Boot lands in** | Fullscreen chat box (`elizad` Tauri shell) on a minimal sway desktop | Real Linux desktop (GNOME by default, or i3/sway/KDE swappable) with Milady Electrobun app auto-launched |
| **Desktop environment** | sway, minimal, no panel, no notifications surface | GNOME (Tails default), or whatever the user installs |
| **The user's mental model** | "I'm talking to a computer-that's-also-an-assistant" | "I'm using a Linux desktop, and Milady is my AI co-pilot app" |
| **Other apps visible** | Only those Milady spawns through OPEN_APP | Everything — file manager, terminal, browser, anything apt installs |
| **Notifications** | Via chat (Eliza talks to you) | Native Linux notifications (notify-osd, GNOME shell, etc.) — plus chat |
| **State / persistence** | Stateless tmpfs (LUKS opt-in, see decision #19) | Stateless tmpfs (same model — LUKS partition for `~/.milady`) |
| **Live-build base** | Custom-stripped Debian | Tails-derived (privacy-conscious live-USB plumbing, Tor optional) |
| **Network access by default** | Wired NetworkManager, wifi via chat flow | Same — plus Tails' wifi/wired stack |
| **License posture** | Apache-2.0 (own) + GPL-3 (Tails-derived bits) | GPL-3-or-later (Tails-derived base is more substantial here) |

## Shared code, separate ISOs

Both ISOs ship the same agent. The differences are at the live-build
layer:

```
packages/os/linux/
├── agent/                       ← shared agent code, used by both
├── crates/                      ← shared Rust (cap-bus, sandbox, types, elizad)
├── docs/                        ← shared architecture docs (eliza-integration.md, etc)
│
├── live-build/                  ← usbeliza-specific live-build config
├── Justfile                     ← usbeliza Justfile
├── tests/                       ← usbeliza tests
│
└── variants/
    └── milady-tails/
        ├── live-build/          ← milady-tails-specific live-build config
        ├── Justfile             ← milady-tails Justfile (will import shared recipes)
        ├── docs/                ← this file + customization vocabulary, etc.
        └── scripts/             ← variant-specific build helpers
```

So when a bug gets fixed in the agent it benefits both variants. When
the live-build script changes for usbeliza, milady-tails is unaffected
(separate config tree).

## Why two variants instead of one

- **Different audiences.** Privacy-conscious users + minimalists pick
  usbeliza. Linux power users who want an AI co-pilot pick milady-tails.
- **Different constraints, different correct designs.** Forcing one ISO
  to serve both audiences means the kiosk users complain about the
  panel, and the desktop users complain about the lack of file manager.
- **The agent stack is the same.** No duplication on the "intelligence"
  layer.

## Could they merge later?

Maybe. If a runtime "session mode" flag could swap the boot target
(kiosk vs. full desktop) inside a single ISO, the two variants collapse
to one. That's an interesting future direction but not the right call
today — the live-build skeletons diverge enough that early on it's
clearer to keep them separate.

## Decision log

- **2026-05-13**: Initial scaffold. `milady-tails` lives at
  `packages/os/linux/variants/milady-tails/`. Chose this location over
  `packages/os/linux-milady/` (sibling) because the agent + crates + docs
  are shared and the variants pattern reflects that.
