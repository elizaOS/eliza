# Phase 7 — Persistent encrypted USB integration

User opts into LUKS persistence via the greeter; Milady's data survives
reboots; **no Tails persistence code is modified, only added
configuration**. Paths: `TAILS = packages/os/linux/variants/milady-tails/tails`.

Status as of 2026-05-16: the `MiladyData` backend feature, frontend row,
and on-activated cleanup hook exist in source and are part of the current
rebuild/test pass. They still need QEMU/USB validation in a live ISO.

## Key finding: this Tails release uses modern Persistent Storage (`tps`)

The original plan said "reuse `tails-persistence-setup`", but this Tails
tree replaced the legacy Perl GTK app with the Python **Persistent Storage**
stack (`tps` backend + `tps_frontend` UI). It still writes a
`persistence.conf` in the live-boot(5) format — same kernel machinery —
but feature definitions live in **code**, not a static preset file.

Relevant files (under `TAILS/config/chroot_local-includes/`):
- `usr/lib/python3/dist-packages/tps/configuration/features.py` — the
  preset definitions; `get_classes()` auto-discovers every `Feature` subclass.
- `.../tps/configuration/feature.py` — the `Feature` base class.
- `.../tps/configuration/binding.py` — `Binding(src, dest, …)`; activation
  is a nosymfollow bind-mount, bootstrapped from `dest` on first activation.
- `.../tps/configuration/config_file.py` — writes `persistence.conf`.
- `.../tps/service.py` — `do_create()` activates every `enabled_by_default`
  feature right after LUKS format.
- `usr/share/tails/persistent-storage/features_view.ui.in` — the GTK UI;
  **requires** per-feature `<id>_box`/`_row`/`_switch` widgets or the
  frontend raises `RuntimeError`.
- `usr/local/lib/persistent-storage/on-activated-hooks/<FeatureId>/` —
  optional post-activation hook scripts (run as root).

## 1. The `MiladyData` feature — the entire backend change

Add **one `Feature` subclass** to `tps/configuration/features.py`.
`get_classes()` picks it up automatically; no registration list to edit.

```python
class MiladyData(Feature):
    Id = "MiladyData"
    translatable_name = "Milady AI"
    Bindings = (
        Binding("milady/dot-eliza",  "/home/amnesia/.eliza"),
        Binding("milady/dot-milady", "/home/amnesia/.milady"),
        Binding("milady/config",     "/home/amnesia/.config/milady"),
    )
    enabled_by_default = True
    conflicting_apps = (
        ConflictingApp(name="Milady", desktop_id="milady.desktop",
                       process_names=["milady", "bun"]),
    )
```

- `~/.eliza` and `~/.milady` are both real, separate live state roots —
  not aliases. Both must persist. Tails' live user is `amnesia` (uid 1000).
- `~/.config/milady/` — matches PLAN's "custom themes, dotfile customizations".
- `enabled_by_default = True` is the parity lever: when the user creates
  Persistent Storage, `service.do_create()` auto-activates `MiladyData` —
  "persistent mode" means Milady's state persists, period, no hunting for
  a switch.
- `conflicting_apps` — `tps` blocks activate/deactivate while Milady runs,
  to avoid corrupting a live bind-mount.
- Whole-directory bind-mounts (not `link`/symlinks) — `~/.eliza` etc. hold
  a DB, models, logs that must persist in full.

This produces, when enabled, these `persistence.conf` lines (you never
hand-write the file — `tps` generates it from `Bindings`):
```
/home/amnesia/.config/milady	source=milady/config
/home/amnesia/.eliza	source=milady/dot-eliza
/home/amnesia/.milady	source=milady/dot-milady
```

**Wi-Fi** (`/etc/NetworkManager/system-connections/`) is already Tails'
`NetworkConnections` feature — do **not** re-declare it (duplicate binding).

**Not persisted** (ephemeral in both modes): `~/.eliza/sockets/` — Unix
sockets are runtime-only; handle via an on-activated hook (you can't
exclude a subdir of a bind-mount), not a binding.

## 2. Parity correctness — same paths in both modes

`tps`'s design gives this for free:
- **Amnesia**: `~/.eliza` doesn't exist yet; Milady creates it on first
  launch, in RAM, wiped on shutdown.
- **Persistent**: at boot after greeter unlock, `tps` bind-mounts the
  LUKS-backed dir over `/home/amnesia/.eliza` *before the session starts*.
  Milady writes to `~/.eliza` — **exact same path**.

The Milady app and the agent contain **zero persistence-aware
branching** — the only difference is whether `/home/amnesia/.eliza` is a
tmpfs dir or a bind-mount, invisible above the VFS layer. First-activation
bootstrap (`binding.py` does `cp -a dest src` if the LUKS source is empty)
means an amnesia→persistent transition mid-session loses no data.

## 3. The on-activated hook

`TAILS/config/chroot_local-includes/usr/local/lib/persistent-storage/on-activated-hooks/MiladyData/10-clean-runtime-state`
(executable, runs as root after the bind-mount):
- remove stale Chromium/Electrobun runtime cache and singleton lock files
  under `/home/amnesia/.eliza` (`Cache`, `Code Cache`, `GPUCache`,
  `DawnCache`, `Crashpad`, `LOCK`, `Singleton*`).
- Ownership normalization is a possible hardening follow-up if live
  validation finds mixed owners; it is not in the current hook.

Directory name **must** equal `Feature.Id` (`MiladyData`).

## 4. The GTK UI row (required or the frontend crashes)

`tps_frontend/feature.py` requires `milady_data_box`/`_row`/`_switch`
widgets in `features_view.ui.in` or it raises `RuntimeError` at startup.
Add a row to `TAILS/config/chroot_local-includes/usr/share/tails/persistent-storage/features_view.ui.in`
— copy an existing simple row (e.g. `gnu_pg_row`), rename the three widget
ids to the `milady_data_` prefix, title "Milady AI", subtitle "Chat
history, built apps, downloaded models, sign-in". Because
`enabled_by_default=True`, the switch is pre-toggled after Create.

## 5. Chat actions (identification only — these are agent-side, Phase 6/9)

Two new elizaOS Actions in the Milady agent, NOT Tails code:
- **"save my work to encrypted USB"** — query the `tps` D-Bus service
  `org.boum.tails.PersistentStorage` `IsCreated`; if false, `exec
  /usr/local/bin/tails-persistent-storage` (Tails' GUI). Do **not**
  reimplement LUKS — that was the older prototype's mistake. The chat
  surface can be simple, but its runner must point at `tpscli` / the
  D-Bus service.
- **"what's on my persistent storage?"** — enumerate enabled features via
  `tpscli`/D-Bus, `du -sh` each binding dest.

The Tails-side contract Phase 7 owns: `/etc/elizaos/...` is irrelevant
here — `tps`'s D-Bus service + `persistence.conf` are the source of truth.

## 6. Lessons from older prototype persistence bugs to avoid

The older prototype hand-rolled a shell+`cryptsetup` script and hit: a hardcoded
partition slot (bricked the EFI partition), a LUKS in-use kernel lock, and
mount-path drift. `tps` already solved every one — **that is the whole
point of "Tails-native".** So: do not write partition-selection logic, do
not pre-create partitions in a build hook, do not hardcode mount paths
(the `Feature` uses relative `src` paths). And inspect the built squashfs
to confirm the modified `features.py` is actually in it (don't trust grep).

## Ordered implementation checklist
1. Add the `MiladyData` `Feature` subclass to `tps/configuration/features.py`. Done locally.
2. Add the `milady_data_*` row to `features_view.ui.in`. Done locally.
3. Add the `on-activated-hooks/MiladyData/10-clean-runtime-state` hook. Done locally.
4. Confirm Tails' `NetworkConnections` feature is offered in the greeter UI — do NOT re-declare it.
5. Add the 2 agent chat actions (thin — shell Tails' GUI).
6. Build the ISO; inspect the squashfs for the 3 modified/added files.
7. QEMU multi-partition USB test: amnesia first-boot → create-via-chat → reboot → greeter unlock → state intact → confirm `~/.eliza` is a bind-mountpoint and `sockets/` was wiped. Repeat the create→unlock leg under Privacy Mode (persistence is orthogonal to Tor).
8. Record any amnesia/persistent behavior difference in `docs/mode-parity.md` before merge.
