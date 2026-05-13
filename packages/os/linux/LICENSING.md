# Licensing

usbeliza is dual-licensed at the repository level:

- The project's own code is **Apache-2.0** — see `/LICENSE` for the
  canonical text, and `/LICENSES/Apache-2.0.txt` for the SPDX-canonical
  body.
- Vendored Tails files under `third-party/tails/` are
  **GPL-3.0-or-later** — see `third-party/tails/LICENSE` (copied
  verbatim from upstream Tails' `COPYING`), and
  `/LICENSES/GPL-3.0-or-later.txt` for the SPDX-canonical body. The GPL
  terms apply only to derivative works of those specific files.

Every source file outside `third-party/tails/` carries the SPDX header
`SPDX-License-Identifier: Apache-2.0`. Every source file inside
`third-party/tails/` carries `SPDX-License-Identifier:
GPL-3.0-or-later` (matching upstream Tails).

The **combined live ISO is distributed as GPL-3.0-or-later in aggregate**
because the GPL is viral when GPL-licensed components ship together with
the rest of the OS. This matches the upstream Tails posture. Distributing
source under the strongest license in the bundle is the legally clean
path.

See `/NOTICE.md` for the full list of third-party derivations and their
upstream provenance.
