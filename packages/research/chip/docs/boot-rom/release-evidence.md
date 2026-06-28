# Boot ROM release evidence

The E1 secure-boot mask ROM is the rv64imac image built from `fw/boot-rom`
(`reset.S` calling the OPNPHN01 verifier: Ed25519 + SHA-256, key ladder,
rollback, lifecycle, and the boot measurement chain). Build the artifacts with:

```sh
make -C fw/boot-rom secure-rom
```

The build emits:

- `build/boot-rom/e1_secure_boot_rom.elf`
- `build/boot-rom/e1_secure_boot_rom.bin`
- `build/boot-rom/e1_secure_boot_rom.hex`

`fw/boot-rom/check_boot_rom.py` rebuilds these files and verifies the source,
linker, RTL contract, and artifact bounds.

## RTL wiring

`rtl/bootrom/e1_bootrom.sv` loads the generated executable image via
`$readmemh` from the `ROM_HEX` parameter (default
`build/boot-rom/e1_secure_boot_rom.hex`). The first four words remain the debug-visible
identity/version header (magic `OSO`, `CHIP`, format version, and the
`32'h0000_1000` handoff word) so external bring-up tooling and the static
boot-chain contract can fingerprint the ROM independent of the loaded image.

## Simulator boot transcript

The ROM image is executed in `qemu-system-riscv64` (QEMU `virt`, `-bios none`)
and the reset/verify/handoff trace is captured to a checked-in artifact:

- transcript: [`transcripts/e1_secure_bootrom_qemu_rv64.txt`](transcripts/e1_secure_bootrom_qemu_rv64.txt)
- reproduce: `scripts/run_bootrom_sim_transcript.sh`
- gate: `scripts/check_bootrom_sim_transcript.py`
  (report `build/reports/gate-bootrom-sim-transcript-check.json`)

The captured transcript proves, against the real ROM machine code:

| marker | PC | evidence |
| --- | --- | --- |
| reset-vector fetch | `0x80000000` | `_start` `auipc t0,0` — the reset vector executes the ROM image |
| `mtvec` setup | `0x80000008` | `csrw mtvec,t0` programs the local trap handler `e1_bootrom_trap` |
| MIE clear | `0x8000000c` | `csrci mstatus,8` masks interrupts before handoff |
| verifier call | `0x8000001c` | `jalr` into `e1_secure_boot_main` (the C secure-boot entrypoint) |
| fail-closed trap | `0x80000028` | `wfi` in `e1_bootrom_trap` — the reset vector halts |

On this run the platform bindings are the fail-closed weak defaults: no
provisioned OTP root hash and no signed first-stage image are present. The
verifier therefore returns `0`, the `beqz a0` at `0x80000020` takes the trap
branch, and the core spins in the WFI loop. Nothing is booted without
authentication. This fail-closed trap is the intended negative evidence for the
secure-boot threat model: the absence of a provisioned root and a valid signed
image must halt the boot, not fall through to an unverified handoff.

## Claim boundary

The transcript is a development simulator trace on `qemu-system-riscv64`. It
demonstrates that the reset vector reaches the ROM, the verifier entrypoint
runs, and the ROM fails closed when authentication inputs are absent. It is
scoped strictly to the named simulator and the ROM machine code; it is not a
silicon secure-boot attestation. The hardware root of trust (OTP/PUF root hash
provisioning) and the signed first-stage image window are physical and
provisioning dependencies covered by the RoT RTL (`rtl/security/rot/`) and the
key-ceremony and AVB lifecycle records, not by this trace.

A positive (authenticated handoff) transcript additionally requires a
provisioned test OTP root hash and a validly signed test image from the W7
reference builder (`tests/security/negative/opnphn.py`) bound into the ROM
image window; that path reuses the same runner and gate.

The positive handoff evidence is tracked by a separate fail-closed gate so the
negative transcript above cannot satisfy firmware/OS readiness:

- transcript:
  [`transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt`](transcripts/e1_secure_bootrom_positive_handoff_qemu_rv64.txt)
- capture wrapper: `scripts/capture_bootrom_positive_handoff.sh`
- gate: `scripts/check_bootrom_positive_handoff.py`
  (report `build/reports/gate-bootrom-positive-handoff-check.json`)

That gate requires the capture-wrapper claim boundary and `command_exit_code: 0`
provenance markers in addition to reset-vector, verifier-entrypoint,
authenticated-image, manifest-selected handoff target, and OpenSBI-entry
markers. Until the signed image transcript exists, it writes a `BLOCKED` report
and the aggregate boot security-chain contract stays in its fail-closed state.
