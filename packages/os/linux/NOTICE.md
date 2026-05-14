# NOTICE

This file documents third-party code included in this repository, the
license under which it is distributed, and the upstream provenance of
each derived file.

## License posture summary

- **`LICENSE`** at repo root: Apache License 2.0 — the primary license for
  this project's *own* code.
- **`LICENSES/Apache-2.0.txt`** and **`LICENSES/GPL-3.0-or-later.txt`**:
  full SPDX-canonical text bodies for the licenses used in this tree.
- Every source file outside `third-party/tails/` carries the SPDX header:
  `SPDX-License-Identifier: Apache-2.0`.
- Every source file *inside* `third-party/tails/` carries the SPDX header:
  `SPDX-License-Identifier: GPL-3.0-or-later` (matching upstream Tails).
- The **combined live ISO is GPL-3 in distributable form** because the GPL
  is viral when GPL-licensed components ship together with the rest of the
  OS. This is the same posture as the upstream Tails project. Distributing
  source under the strongest license in the bundle is the legally clean
  path.

## Third-party derivations

### Tails (`https://tails.net`, GPL-3.0-or-later)

`third-party/tails/` contains code lifted from the upstream Tails project,
re-used per locked decision #22 with the project team's licensing clearance.

Upstream commit: `18836d179138270f03082449d6417712f2a827b3`
(captured 2026-05-11 from `git rev-parse HEAD` in the Tails working copy).

| Local path | Upstream source (under `config/chroot_local-includes/`) | Modifications |
|---|---|---|
| `third-party/tails/etc/tails-get-network-time.conf` | `etc/tails-get-network-time.conf` | SPDX header added |
| `third-party/tails/usr/lib/python3/dist-packages/tailslib/__init__.py` | `usr/lib/python3/dist-packages/tailslib/__init__.py` | SPDX header added |
| `third-party/tails/usr/lib/python3/dist-packages/tailslib/persistence.py` | `usr/lib/python3/dist-packages/tailslib/persistence.py` | SPDX header added |
| `third-party/tails/usr/lib/python3/dist-packages/tailslib/utils.py` | `usr/lib/python3/dist-packages/tailslib/utils.py` | SPDX header added |
| `third-party/tails/usr/lib/systemd/system/tails-shutdown-on-media-removal.service` | `lib/systemd/system/tails-shutdown-on-media-removal.service` | SPDX header added |
| `third-party/tails/usr/lib/systemd/system-shutdown/tails` | `lib/systemd/system-shutdown/tails` | SPDX header added |
| `third-party/tails/usr/local/lib/have-wifi` | `usr/local/lib/have-wifi` | SPDX header added |
| `third-party/tails/usr/local/lib/tails-boot-device-can-have-persistence` | `usr/local/lib/tails-boot-device-can-have-persistence` | SPDX header added |
| `third-party/tails/usr/local/lib/tails-get-network-time` | `usr/local/lib/tails-get-network-time` | SPDX header added |
| `third-party/tails/usr/local/lib/tails-shell-library/log.sh` | `usr/local/lib/tails-shell-library/log.sh` | SPDX header added |
| `third-party/tails/usr/local/lib/tails-shell-library/network.sh` | `usr/local/lib/tails-shell-library/network.sh` | SPDX header added |
| `third-party/tails/usr/local/lib/tails-unblock-network` | `usr/local/lib/tails-unblock-network` | SPDX header added |
| `third-party/tails/usr/local/sbin/htpdate` | `usr/local/sbin/htpdate` | None — existing GPLv2-or-later notice preserved (compatible with GPL-3.0-or-later) |
| `third-party/tails/usr/local/sbin/tails-block-device-info` | `usr/local/sbin/tails-block-device-info` | SPDX header added |
| `third-party/tails/usr/local/sbin/tails-notify-user` | `usr/local/sbin/tails-notify-user` | SPDX header added |

File modes are preserved (the `+x` bit is intact on every script that
upstream marked executable). The original GPL-3 license body lives at
`third-party/tails/LICENSE` (copied verbatim from upstream's `COPYING`).

Further Phase 1 imports (`tails-persistence-setup`,
`tails-persistence-setup-helper`, `live-additional-software`, AppArmor
profile baseline, Plymouth theme) will be appended to the table above as
they land.

### Other third-party code

None at this time. Any future third-party imports under non-Apache-2.0
licenses must be added to this file with the same metadata fields.
