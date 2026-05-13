# Safety

> **One-line guarantee:** booting usbeliza from a USB stick **does not modify
> your computer's existing operating system or data**. Remove the stick and
> reboot — you're back where you started.

## Why this is true

The USB stick has its own bootable OS layout:

```
sdX1   FAT32, 256 MB     EFI + GRUB    (lives on the USB)
sdX2   ext4, ~6 GB, RO   base image    (lives on the USB)
sdX3   LUKS+ext4, rest   persistence   (lives on the USB)
```

Your laptop's internal disk does not appear in any of these slots. When
usbeliza boots, the kernel mounts:

- `sdX2` as the root filesystem, **read-only**.
- An overlay-fs upper layer in **RAM**.
- `sdX3` (the encrypted partition on the USB) for persistent state, only
  if you've unlocked it with your passphrase.

Writes go to RAM unless explicitly persisted to `sdX3`. Power off → RAM
clears → writes evaporate.

The TTY (Ctrl+Alt+F2) drops you into the same overlay. Even root commands
write to the overlay layer; the read-only base image cannot be modified
through normal use.

## Three real risks the user should know about

These are the only ways usbeliza can leave a trace on the host machine.
We document them prominently.

### 1. BIOS boot-order may persist after first boot

Some firmware (especially older laptops) treats "boot from USB" as a
permanent setting. The next time you boot without the USB plugged in,
you'll see a "no bootable device" message until you fix the boot order
in BIOS setup. **This does not damage anything**, and the fix is one BIOS
toggle.

### 2. Secure Boot may need a one-time disable

usbeliza's ISO is currently unsigned (the LF-signed shim is on the
roadmap — see locked decision #18 in `PLAN.md`). To boot on a stock
Windows laptop with Secure Boot enabled, the user needs to disable
Secure Boot once in BIOS setup. **Re-enabling Secure Boot is one
toggle**; their normal OS boots normally either way.

### 3. Installing usbeliza to a host disk would be different and risky

usbeliza **does not currently install to internal disks**. There is no
"Install to disk" button, no `dd if=usbeliza.iso of=/dev/sda`, no
GRUB-on-host modification. Phase 0 through Phase 4 of `PLAN.md` keep
this surface deliberately empty.

If "Install to disk" is ever added (Phase 5+ at the earliest), it will
ship as a separate ISO target with explicit warnings, multiple
confirmation prompts, a forced backup step, and conspicuous documentation
that it *does* modify the host. Until then: usbeliza is live-USB only,
and your computer is safe.

## What we *do* write to disk on the USB

When the user runs `tails-persistence-setup` after first boot, the
following land on the LUKS-encrypted `sdX3`:

- `~/.eliza/calibration.toml` — the 8 calibration answers.
- `~/.eliza/apps/<slug>/` — generated apps, their `data/`, and the rolling
  `.history/` of last 5 versions.
- `~/.eliza/db.sqlite` — conversation log + trajectory table.
- `~/.eliza/auth/{claude,codex}.json` — OAuth tokens (encrypted at rest).
- `~/.eliza/models/` — Llama-3B GGUF (downloaded after first network connect).

All on the USB. Nothing on the host disk.

## Comparison to Tails

usbeliza inherits Tails' core safety guarantee: live-USB mode never modifies
the host. We borrow Tails' persistence-setup tooling directly (locked
decision #22; `third-party/tails/`) so the LUKS partition flow has the same
battle-tested wizard.

We diverge from Tails on:

- Tor-everywhere posture: not the default; opt-in via `/mode private`.
- Greeter UX: replaced by the Her-inspired conversational calibration.

If your primary need is anonymity, you may be better served by Tails
itself. usbeliza optimizes for "AI-native OS that doesn't break your
machine," not "untraceable internet usage."
