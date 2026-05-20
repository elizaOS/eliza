<!-- elizaOS RV64 variant userland-bootstrap (Wave 2B / first-boot scaffold) -->
# elizaOS RV64 — Userland Startup

This document describes how the elizaOS agent comes up on the Debian
RISC-V 64 live image. It pairs with the live-build artifacts under
[`../config/`](../config/) and is consumed by the qemu-virt harness to
decide whether a given boot is healthy.

The systemd units, first-boot script, `elizaos` system user, and
`/opt/elizaos` runtime payload are wired by the live-build hooks. Agent
liveness is separate from first-boot readiness and must be backed by a
service-active check plus `/api/health`.

## Boot sequence

```
firmware (OpenSBI/U-Boot)
        ↓
kernel + initramfs (live-boot)
        ↓
systemd PID 1
        ↓
local-fs.target ─→ systemd-tmpfiles-setup.service
        ↓
network-online.target          (NetworkManager + iproute2)
        ↓
elizaos-first-boot.service     (Type=oneshot, RemainAfterExit=yes)
        ├─ create elizaos user + group
        ├─ create /var/lib/elizaos (0750, elizaos:elizaos)
        ├─ create /etc/elizaos    (0750, root:elizaos)
        ├─ generate /etc/elizaos/instance-id (UUIDv4)
        ├─ write "elizaos-firstboot-ready instance=<uuid>" to /dev/ttyS0
        ├─ systemctl enable + start elizaos-agent.service
        ├─ touch /var/lib/elizaos/.first-boot-complete
        └─ systemctl disable elizaos-first-boot.service
        ↓
elizaos-agent.service          (Type=simple, Restart=on-failure)
        └─ /opt/elizaos/bin/elizaos start --headless --port=31337
```

The first-boot service is gated by
`ConditionPathExists=!/var/lib/elizaos/.first-boot-complete` so it
becomes a no-op on subsequent boots even if the disable step failed.
The disable step itself runs both as an `ExecStartPost=` on the unit
and as an explicit `systemctl disable` call from the script — whichever
arrives first wins, and the other is harmless.

## Unit ordering rules

| Unit | After | Before | Wants | WantedBy |
|---|---|---|---|---|
| `elizaos-first-boot.service` | `local-fs.target`, `systemd-tmpfiles-setup.service` | `multi-user.target`, `elizaos-agent.service` | — | `multi-user.target` |
| `elizaos-agent.service` | `network-online.target`, `multi-user.target` | — | `network-online.target` | `multi-user.target` |

The ordering guarantees that:

1. The local filesystem and tmpfiles are present before first-boot
   touches `/var/lib/elizaos` or `/etc/elizaos`.
2. The agent unit cannot start until the elizaos user, state dir,
   config dir, and instance id all exist.
3. The agent always sees a usable network because
   `network-online.target` is pulled in via `Wants=` and ordered via
   `After=`.

## First-boot marker convention

The first-boot script writes a single line to `/dev/ttyS0`:

```
elizaos-firstboot-ready instance=<uuid>
```

The `<uuid>` matches the contents of `/etc/elizaos/instance-id` and is
generated once on the first successful boot. This is the **only**
ready signal the qemu-virt harness depends on; do not relocate it,
reformat it, or emit additional `elizaos-firstboot-ready` lines from any other
unit. The harness greps for `^elizaos-firstboot-ready instance=` on the captured
serial transcript.

If `/dev/ttyS0` is not writable (e.g. on a real RISC-V dev board with
a different UART), the script falls back to `/dev/kmsg` so the line
still appears in `dmesg`. The serial-console path is the contract; the
`/dev/kmsg` path is a debug aid.

A successful first boot also persists:

- `/etc/elizaos/instance-id` — root:elizaos 0640, UUIDv4
- `/var/lib/elizaos/.first-boot-complete` — elizaos:elizaos 0640,
  UTC timestamp of completion

## Agent Liveness

First-boot completion and agent liveness are separate signals:

| Outcome | `elizaos-firstboot-ready` on `ttyS0` | `elizaos-agent-ready` on `ttyS0` | `/api/health` | `elizaos-agent.service` state |
|---|---|---|---|---|
| Boot fine, agent live | **yes** | **yes** | HTTP 200 | `active (running)` |
| Boot fine, agent unhealthy | **yes** | **no** | missing/failing | not active or failed |
| Boot broken | **no** | **no** | irrelevant | irrelevant |

`elizaos-agent-ready` is emitted only after systemd reports the service
active and `wait-agent-health.sh` receives a successful response from
`http://127.0.0.1:31337/api/health`.

## File map

| Path on the live image | Source under `config/` |
|---|---|
| `/etc/systemd/system/elizaos-agent.service` | `includes.chroot/etc/systemd/system/elizaos-agent.service` |
| `/etc/systemd/system/elizaos-first-boot.service` | `includes.chroot/etc/systemd/system/elizaos-first-boot.service` |
| `/usr/lib/elizaos/first-boot.sh` | `includes.chroot/usr/lib/elizaos/first-boot.sh` |
| `/usr/lib/elizaos/wait-agent-health.sh` | `includes.chroot/usr/lib/elizaos/wait-agent-health.sh` |
| `/opt/elizaos/` (agent runtime tree) | created by `hooks/normal/0010-elizaos-agent.hook.chroot` |

## What this wave does NOT do

- It does not configure Cloud login, model downloads, or any
  connector. The agent runs `--headless --port=31337` against a fresh
  state directory.
- It does not touch the bootloader, kernel command line, or the
  greeter — those belong to the build-config and qemu-harness agents.
- It does not create persistent user accounts beyond the system
  `elizaos` user.

## Cross-references

- Variant root: [`../README.md`](../README.md)
- Sibling reference (do not copy Tails-specific logic):
  [`../../milady-tails/`](../../milady-tails/)
- elizaOS source-of-truth agent stack: `packages/os/linux/agent/`
- Distribution overview: [`../../../CLAUDE.md`](../../../CLAUDE.md)
