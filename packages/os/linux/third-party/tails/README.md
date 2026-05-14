# third-party/tails — GPL-3.0-or-later

## Provenance

Files in this directory tree are lifted verbatim from the upstream
[Tails project](https://tails.net) (working copy at
`/home/nubs/Git/tails`) and remain licensed under **GPL-3.0-or-later**,
matching upstream. The Tails project team has cleared usbeliza to vendor
these specific files; see locked decision #22 in `/PLAN.md`.

The repository's primary license is **Apache-2.0** (see `/LICENSE`); the
GPL terms apply only to derivative works of these specific files. The
combined live ISO is therefore distributed as GPL-3.0-or-later in
aggregate (the same posture upstream Tails uses).

## Upstream commit

```
18836d179138270f03082449d6417712f2a827b3
```

Captured on 2026-05-11 from `git rev-parse HEAD` inside
`/home/nubs/Git/tails`.

## Imported files

The on-disk layout under this directory mirrors Tails' installed layout
(the `config/chroot_local-includes/` prefix is dropped). Two files
(`tails-block-device-info`, `tails-notify-user`) live under
`usr/local/sbin/` upstream rather than `usr/local/lib/` — they are
imported at their actual upstream paths.

| Local path                                                                                              | Upstream path                                                                                          |
|---------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| `usr/lib/python3/dist-packages/tailslib/__init__.py`                                                    | `config/chroot_local-includes/usr/lib/python3/dist-packages/tailslib/__init__.py`                       |
| `usr/lib/python3/dist-packages/tailslib/persistence.py`                                                 | `config/chroot_local-includes/usr/lib/python3/dist-packages/tailslib/persistence.py`                    |
| `usr/lib/python3/dist-packages/tailslib/utils.py`                                                       | `config/chroot_local-includes/usr/lib/python3/dist-packages/tailslib/utils.py`                          |
| `usr/lib/systemd/system/tails-shutdown-on-media-removal.service`                                        | `config/chroot_local-includes/lib/systemd/system/tails-shutdown-on-media-removal.service`              |
| `usr/lib/systemd/system-shutdown/tails`                                                                 | `config/chroot_local-includes/lib/systemd/system-shutdown/tails`                                        |
| `usr/local/lib/have-wifi`                                                                               | `config/chroot_local-includes/usr/local/lib/have-wifi`                                                  |
| `usr/local/lib/tails-boot-device-can-have-persistence`                                                  | `config/chroot_local-includes/usr/local/lib/tails-boot-device-can-have-persistence`                     |
| `usr/local/lib/tails-get-network-time`                                                                  | `config/chroot_local-includes/usr/local/lib/tails-get-network-time`                                     |
| `usr/local/lib/tails-shell-library/log.sh`                                                              | `config/chroot_local-includes/usr/local/lib/tails-shell-library/log.sh`                                 |
| `usr/local/lib/tails-shell-library/network.sh`                                                          | `config/chroot_local-includes/usr/local/lib/tails-shell-library/network.sh`                             |
| `usr/local/lib/tails-unblock-network`                                                                   | `config/chroot_local-includes/usr/local/lib/tails-unblock-network`                                      |
| `usr/local/sbin/htpdate`                                                                                | `config/chroot_local-includes/usr/local/sbin/htpdate`                                                   |
| `usr/local/sbin/tails-block-device-info`                                                                | `config/chroot_local-includes/usr/local/sbin/tails-block-device-info`                                   |
| `usr/local/sbin/tails-notify-user`                                                                      | `config/chroot_local-includes/usr/local/sbin/tails-notify-user`                                         |
| `etc/tails-get-network-time.conf`                                                                       | `config/chroot_local-includes/etc/tails-get-network-time.conf`                                          |

## License attribution

Files retain their GPL-3.0-or-later license. usbeliza's own code outside
this directory is Apache-2.0; the GPL terms apply only to derivative
works of these specific files. The full GPL-3.0 text is in this
directory's `LICENSE` (copied verbatim from upstream Tails' `COPYING`).

## Local modifications

Every imported file received an SPDX header at the top (just after the
shebang, where applicable):

```
# Copyright (C) 2009-2026 Tails developers <tails@boum.org>
# Licensed under the GNU General Public License v3.0 or later — see LICENSE
# SPDX-License-Identifier: GPL-3.0-or-later
```

`htpdate` already carried an upstream copyright + GPLv2-or-later
notice; that header is preserved verbatim and is compatible with the
GPL-3.0-or-later posture of the rest of this directory.

No other modifications were made — file contents and modes (including
the `+x` bit on all originally-executable scripts) are preserved.

## Required hygiene for future additions

1. Keep the upstream Tails GPL-3 header verbatim on every file.
2. Add an SPDX line `SPDX-License-Identifier: GPL-3.0-or-later` at the
   top of each file.
3. Record provenance in this README and in `/NOTICE.md`: the upstream
   path, the commit SHA, the date imported, and any local modifications.
4. Do *not* import Tails code outside this directory. Cross-directory
   imports break the dual-license CI gate and confuse downstream
   distributors.
