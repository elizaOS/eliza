# elizaOS secure profile

A hardening overlay composed onto the default elizaOS Linux config when
`ELIZAOS_PROFILE=secure`. `build.sh` copies this directory's `config/`
layout over the base `config/` before `lb build`. Works on all arches.

## What it provides

- **Tor routing** — `tor` + `torsocks`; the `tor` service is enabled at
  boot.
- **AppArmor enforcement** — `apparmor` stack installed, enforced via the
  `apparmor=1 security=apparmor` kernel cmdline and `aa-enforce` at build.
- **MAC randomization** — NetworkManager drop-in randomizes Wi-Fi and
  Ethernet MACs and varies `connection.stable-id` per boot.
- **Amnesic tmpfs home** — `/home` is a RAM-only tmpfs (systemd
  `home.mount`); user data is discarded on shutdown.
- **Hardening sysctls** — `kernel.kptr_restrict`, `kernel.dmesg_restrict`,
  `net.ipv4.tcp_syncookies`, `kernel.unprivileged_bpf_disabled`.
- **Host firewall** — `nftables` service enabled.
- **USB authorization** — `usbguard`.
- **Auto security updates** — `unattended-upgrades`.
- **Private per-user /tmp** — `libpam-tmpdir`.

## Provenance

Built entirely from standard Debian (Trixie) packages plus the
elizaOS-authored chroot hooks in this directory. It is **not** derived
from any third-party live-OS, so it carries no upstream license
entanglement beyond the Debian packages themselves.

## Layout

```
package-lists/elizaos-secure.list.chroot           privacy/hardening packages
hooks/normal/0100-elizaos-secure-hardening.hook.chroot   sysctls, AppArmor, services
hooks/normal/0110-elizaos-amnesia.hook.chroot            tmpfs /home mount unit
config/includes.chroot/etc/NetworkManager/conf.d/00-elizaos-macrandom.conf   MAC randomization
```
