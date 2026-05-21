# OpenTitan (lowRISC) — Apache-2.0 license notice

The E1 root-of-trust integration (W1, `rtl/security/rot/`) reuses crypto and
security RTL from the OpenTitan project by lowRISC, vendored via
`scripts/bootstrap_opentitan.sh` into `external/opentitan/opentitan` at the
commit pinned in `external/opentitan/pin-manifest.json`.

- Project: OpenTitan (`https://github.com/lowRISC/opentitan`)
- Vendor: lowRISC C.I.C.
- License: Apache License, Version 2.0
  (`https://www.apache.org/licenses/LICENSE-2.0`)
- Pinned reference: `earlgrey_silver_release_v5` (see the pin manifest for the
  resolved commit SHA).

## What is reused

Per `docs/security/tee-plan/02-root-of-trust.md` §2, the reuse target is the
audited OpenTitan crypto/security blocks: `rom_ctrl`, `keymgr`, `kmac`, `hmac`,
`aes`, `csrng`, `edn`, `entropy_src`, `alert_handler`. `otp_ctrl` and `lc_ctrl`
are **not** reused — they are replaced by the E1-specific W4
(`rtl/security/otp/e1_otp_map.sv`) and W5 (`rtl/security/lc/e1_lc_ctrl.sv`)
blocks.

The E1 RoT TL-UL package (`rtl/security/rot/e1_rot_tlul_pkg.sv`) is a trimmed,
E1-owned reimplementation whose struct layout follows the OpenTitan
`hw/ip/tlul/rtl/tlul_pkg.sv` signature; it carries the Apache-2.0 attribution
in its header comment.

## Integration status (honest, fail-closed)

The OpenTitan blocks are vendored at the pin but, in the current tree, bound in
`e1_rot_top.sv` via fail-closed E1 integration shims
(`rtl/security/rot/e1_rot_crypto_shim.sv`) rather than truly elaborated, because
their full Earl Grey topgen/fusesoc-generated dependency chain is not yet staged
into a Verilator-elaborable filelist. `scripts/check_rot_integration.py` reports
each shimmed block as `BLOCKED` with the named missing dependency. No claim of
working OpenTitan crypto in the E1 RoT may be made until those blocks are
elaborated for real and the gate reports them as integrated.

## Obligations

Apache-2.0 requires retention of copyright, the license text, the NOTICE file
(where present), and attribution of modifications. The vendored checkout
preserves upstream `LICENSE`, `COPYING`, and per-file SPDX headers. Any E1-side
modification to vendored files must be marked; the integration here is wrapper /
shim only and does not modify vendored OpenTitan RTL.
