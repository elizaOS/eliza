# Renode local smoke evidence - 2026-05-19

This record was generated from a real local Renode run. It is qemu-virt
software-reference evidence only, not e1-chip hardware ABI boot evidence.

## Command

```sh
make renode-check
```

## Result

- Status: PASS
- Generated at UTC: 2026-05-19T02:05:43Z
- Renode path: `/opt/homebrew/bin/renode`
- Renode version: `Renode v1.16.1.28836 build: d66b0c2a-202605121600 build type: Release runtime: .NET 10.0.7`
- Expected and observed banner: `eliza e1 qemu`
- Renode process exit: timeout after banner (`renode_process_exit_code=124`,
  `timed_out_after_banner=true`)

## Archived artifacts

The build artifacts are ignored by git, but were archived locally by the smoke:

| Artifact | SHA-256 |
| --- | --- |
| `build/renode/eliza_e1_uart.transcript` | `20c07661e16f3264eea7e0122be3c5b7e1b0aa337298205f0e56d6f6a6ed28e5` |
| `build/renode/eliza_e1_smoke.json` | `11546cd4edd446f767fa1f36960b3bd08b551472cdf9f23bc63fcfac55401ca6` |
| `build/reports/renode_smoke.log` | `20c07661e16f3264eea7e0122be3c5b7e1b0aa337298205f0e56d6f6a6ed28e5` |
| `build/reports/renode_smoke.manifest` | `11546cd4edd446f767fa1f36960b3bd08b551472cdf9f23bc63fcfac55401ca6` |
| `build/renode/eliza_e1_qemu_firmware.elf` | `c95bc519c1d1da8e1335d89a6659f132a77aada59a4e2599be8ae3e56e987f0b` |
| `build/renode/eliza_e1_qemu_reference.log` | `ee0aef6c3a18b0d7a758747b125cc6e65e175764c5ed5564fb70716dfffda538` |

## Transcript markers

```text
Renode, version 1.16.1 (d66b0c2a-202605121600)
Including script(s): /Users/shawwalters/Desktop/npu_experiment/build/renode/eliza_e1_bounded.resc
uart: [host: 0.83s (+0.83s)|virt: 0s (+0s)] eliza e1 qemu
```

## Residual blocker

No Renode install blocker remains on this host. The residual claim boundary is
that this is qemu-virt software-reference evidence only; it is not e1-chip
hardware ABI boot evidence.
