# Power-management firmware architecture

Status: `planning_skeleton_release_blocked`

## Stack

```
                     +-------------------------------------+
   user-space        | Android HAL / Power HIDL            |
                     +-------------------------------------+
                                       |
                                       v
                     +-------------------------------------+
   S-mode Linux      | cpufreq / regulator / clk / thermal |
                     +-------------------------------------+
                                       |
                                       |  SBI MPxy mailbox (SBI v3.0)
                                       v
                     +-------------------------------------+
   M-mode OpenSBI    | sbi_mpxy / rpmi_proxy               |
                     +-------------------------------------+
                                       |
                                       |  RPMI v1.0 frame
                                       v
                     +-------------------------------------+
   AON Ibex PMC      | fw/pmc/src/main.c                   |
                     | rpmi_server.c                       |
                     | dvfs_arbiter.c                      |
                     | pmic_sequencer.c                    |
                     | thermal_policy.c                    |
                     | droop_telemetry.c                   |
                     +-------------------------------------+
                                       |
                                       |  SPMI v2.0 (or I2C-FM+ fallback)
                                       v
                     +-------------------------------------+
   External PMIC set | 6-8 catalog buck/LDO ICs            |
                     +-------------------------------------+
```

## Components

### S-mode Linux drivers

- `cpufreq-sbi-mpxy.c` — Linux 6.x merged. Sends SCMI-equivalent DVFS
  commands over the MPxy mailbox.
- `regulator-sbi-mpxy.c` — voltage / rail enable. Merged for 6.x.
- `thermal-sbi-mpxy.c` — DTS readout and throttle policy hooks.

### M-mode OpenSBI

Pinned at **OpenSBI v1.8.1** (commit `74434f25...`, January 2026). Earlier
prototype evidence pinned v1.5; that release pre-dated upstream MPxy and was
unsuitable for the RPMI v1.0 control plane. Version delta since v1.5:

- v1.6: SBI MPxy framework + RPMI shared-memory transport land in-tree
  (`include/sbi/sbi_mpxy.h`, `lib/sbi/sbi_mpxy.c`,
  `lib/utils/mailbox/rpmi_mailbox.c`,
  `lib/utils/mailbox/fdt_mailbox_rpmi_shmem.c`).
- v1.7: SBI v3.0 alignment, Counter Delegation (CTR), dynamic SSE events.
- v1.8: hart-protection, SiFive CLINTv2, SpacemiT K1 + Andes QiLai platform
  support, plus RPMI message-protocol fan-out
  (`fdt_mpxy_rpmi_{clock,voltage,performance,device_power,sysmsi}.c`).
- v1.8.1: hart-protection PMP-absent fix.

Pin manifest: `external/opensbi/pin-manifest.json`. Build + symbol-presence
evidence: `docs/evidence/power/opensbi-pin-evidence.yaml`.

The build is rebuilt with the Eliza E1 PMC mailbox device-tree fragment
embedded via `FW_FDT_PATH`, so the resulting `fw_dynamic.elf` exposes the
RPMI shmem mailbox node at `/soc/mailbox@10050800` with compatible
`riscv,rpmi-shmem-mbox`. DTS source: `dts/eliza-rocket-pmc.dts(i)`.
SoC integration evidence: `docs/evidence/power/pmc-soc-integration-evidence.yaml`.

### AON Ibex PMC firmware

Targets **RV32IMC** Ibex management core. Lives in `fw/pmc/`:

| File | Role |
| --- | --- |
| `src/main.c` | Boot, init, scheduler loop. |
| `src/rpmi_server.c` | RPMI v1.0 frame parser/serializer; per-service handler dispatch. |
| `src/dvfs_arbiter.c` | DVFS table lookup, AVFS request merge, target-code resolution per rail. |
| `src/pmic_sequencer.c` | PMIC power-on / power-off sequence per rail dependencies. |
| `src/spmi.c` | SPMI v2.0 master bit-bang / accelerator driver. |
| `src/i2c.c` | I2C-FM-plus fallback master. |
| `src/thermal_policy.c` | DTS readout, throttle ladder enforcement. |
| `src/droop_telemetry.c` | Droop / AVFS counter aggregation, leak to Linux. |
| `src/secure_boot.c` | Secure-boot key handling stub (HMAC/ECDSA verification). |

The DVFS arbiter consumes per-corner DVFS tables from `docs/pd/dvfs-tables/`
which the build system flashes into PMC SRAM at boot. Each table entry binds
a frequency target to a voltage code and a stability margin.

## Boot sequence

1. Cold reset on AON. Ibex PMC executes ROM stage from
   `fw/pmc/src/secure_boot.c` (boot ROM lives in `fw/boot-rom/`).
2. PMC firmware enables `VDD_PMC`, `VDD_AON` rails via SPMI POR sequence.
3. PMC firmware reads chip fuses, selects DVFS corner binning (SS/TT/FF).
4. PMC firmware brings up `VDD_SOC_FABRIC`, `VDD_SRAM`, `VDD_CPU_BIG`,
   `VDD_LPDDR_*` in fixed sequence.
5. PMC firmware deasserts CPU reset; CPU jumps to OpenSBI in DRAM.
6. OpenSBI exposes SBI MPxy mailbox; Linux probes and binds drivers.
7. Runtime: Linux issues DVFS / regulator / thermal RPMI calls; PMC arbitrates
   them against AVFS in-situ loop output and translates to SPMI transactions.

## Idle / suspend

PMC enters its scheduler idle hook when no RPMI request is in flight.
On Linux S0i2 / S3 / S4 entry:

- S0i2: PMC gates `PD_CPU_BIG`, `PD_NPU`, `PD_GPU`. SRAM at retention voltage.
- S3:   PMC commands LPDDR self-refresh, gates all logic islands except
        AON + LPDDR domains.
- S4:   Linux persists state. PMC keeps only AON + PMC alive (deep sleep).

Wake events: AON wake controller IRQ -> PMC -> reverse sequence.

## PMIC sequencer state machine

The Ibex PMC runs a single sequencer (`fw/pmc/src/pmic_sequencer.c`) that
serialises rail enable/disable across S-state transitions. The transitions
are atomic at the PMC scheduler level — Linux S-state RPC blocks on the
sequencer return.

### S0 -> S3 entry (suspend)

```
                +----------------+
                |  S0_ACTIVE     |
                +-------+--------+
                        | RPMI:SYSTEM:SUSPEND
                        v
   +--------+    +--------------+    +--------+    +--------+
   | QUIESCE|--->| GATE_GPU     |--->| GATE_  |--->| GATE_  |
   | CPU AP |    | NPU FABRIC   |    | SRAM   |    | CPU_*  |
   +--------+    +--------------+    +--------+    +--------+
   block I/O                                          |
   completion                                         v
                                            +-------------------+
                                            | LPDDR SELF-REFRESH|
                                            +---------+---------+
                                                      | SPMI LPDDR cmd
                                                      v
                                            +-------------------+
                                            | DISABLE BUCKS:    |
                                            | CPU_BIG, LITTLE,  |
                                            | NPU, GPU, FABRIC, |
                                            | SRAM              |
                                            +---------+---------+
                                                      | SPMI per-rail off
                                                      v
                                            +-------------------+
                                            |  S3_DEEP_IDLE     |
                                            +-------------------+
                                            AON + PMC + LPDDR
                                            array supplies only
```

### S3 -> S0 wake (resume)

```
       wake IRQ (AON wake controller)
                 |
                 v
        +-----------------+
        | PMIC POR        |  bring up SOC_FABRIC and SRAM bucks first;
        | (reverse order) |  RPMI POR table -> SPMI commands
        +--------+--------+
                 |
                 v
        +-----------------+
        | LPDDR EXIT      |  command exit from self-refresh
        | SELF-REFRESH    |
        +--------+--------+
                 |
                 v
        +-----------------+
        | RAISE CPU_BIG / |  per-rail SPMI enables; PLLs relock; AVFS arms
        | LITTLE BUCKS    |
        +--------+--------+
                 |
                 v
        +-----------------+
        | RAISE NPU + GPU |  background; SoC can resume Linux before NPU
        | BUCKS           |  is fully online
        +--------+--------+
                 |
                 v
        +-----------------+
        | DEASSERT CPU    |  cpu hart 0 resumes from OpenSBI fw_dynamic
        | RESET           |
        +--------+--------+
                 |
                 v
        +-----------------+
        | S0_ACTIVE       |  RPMI:SYSTEM:RESUME returns to Linux
        +-----------------+
```

### S0 -> S0i2 (lightweight idle)

```
   S0_ACTIVE --(idle hint)--> GATE_NPU --> GATE_GPU --> SRAM_RETENTION
                                                                |
                                                                v
                                                            S0I2_LIGHT
                                                       CPU_BIG retains
                                                       SOC_FABRIC at low
                                                       LPDDR active
```

Reverse on wake: SRAM exit retention -> raise GPU -> raise NPU. No PMIC
power-off transitions; only DVFS code lowering on the SRAM rail.

### S0 -> S4 hibernate

Linux persists state to nvm; PMC then runs the full S3 sequence AND
additionally disables LPDDR array supply after the controller flushes.
PMC remains alive but in deep sleep, polled by RTC. Wake path is BOOT_ROM
reset because DRAM contents are lost.

### Error path

If any SPMI transaction returns NACK during a sequence, the PMC aborts the
transition, marks `PMC_STATUS_FAULT` via `rtl/power/pmc_top.sv`, and
returns RPMI_FAIL_HW_FAULT to S-mode. Linux must replay the suspend; the
PMC restores the rails it had already commanded before the failure.

## Release blockers

- DVFS tables not generated; loop arbitration runs against a single TT-25C
  placeholder until silicon characterization completes.
- SPMI v2.0 master firmware skeleton only.
- Secure-boot key provisioning policy not closed.

## Resolved release blockers

- OpenSBI release tag pinned at v1.8.1 with MPxy + RPMI present in-tree.
  Build artifacts and 89 verified MPxy/RPMI symbols recorded in
  `docs/evidence/power/opensbi-pin-evidence.yaml`.
- OpenSBI v1.8.1 rebuilt against `dts/eliza-rocket-pmc.dts(i)` with
  `FW_FDT_PATH` set to the compiled DTB. The resulting `fw_dynamic.elf`
  embeds the PMC mailbox node + reg-names (verified by `strings` +
  `objdump -t fw_fdt_bin`). Recorded in
  `docs/evidence/power/pmc-soc-integration-evidence.yaml::opensbi_rebuild`.

## Outstanding integration milestone

- MPxy -> RPMI shmem -> AON Ibex roundtrip in cocotb is staged but
  reports `BLOCKED` because three RTL/firmware bindings have not yet
  landed:
    1. `rtl/power/pmc_top.sv` must route mailbox-MMIO accesses at
       offsets `0x800..0xFFF` into the AON SRAM the Ibex data port also
       sees (so the host can publish A2P requests and poll P2A_ACK).
    2. `fw/pmc/src/main.c` must drain the A2P_REQ tail/head pair from
       the new layout instead of polling the legacy `PMC_REG_STATUS`
       scalar register.
    3. `fw/pmc/src/main.c::pmc_boot_rails` must be gated by
       `PMC_ENABLE_PMIC_BRINGUP` so the cocotb build skips SPMI / I2C
       MMIO that traps on off-AON addresses.
  The cocotb test
  `verify/cocotb/integration/test_opensbi_mpxy_to_pmc_rpmi.py`
  guards on `PMC_INSTANTIATE_IBEX` + `PMC_RPMI_SHMEM_ROUNDTRIP`; the
  current default-off path emits the BLOCKED skip with a back-pointer
  to `docs/evidence/power/pmc-soc-integration-evidence.yaml::
  mpxy_rpmi_roundtrip.remaining_bindings`.

## Resolved milestones

- Linker script authored, ELF builds, smoke-run passes.
  `fw/pmc/link.ld` places the firmware at the AON SRAM aperture
  (`0x1005_0000`, 16 KiB), `fw/pmc/src/crt0.S` provides the reset vector
  + GPR/BSS init + stack setup, and the `make elf` target produces
  `fw/pmc/build/pmc.elf` (sha256 recorded in
  `docs/evidence/power/pmc-fw-build-evidence.yaml`). The companion
  `fw/pmc/link.sim.ld` retargets the image at `0x0010_0000` for the
  `Vibex_simple_system` Verilator harness; loading the resulting ELF via
  `--meminit=ram,pmc.sim.elf` retires 129 instructions in 195 cycles and
  enters `pmc_main` without a trap. Production AON Ibex integration in
  `rtl/top/` must drive `boot_addr_i = 32'h1005_0000` to match the
  authored linker script.

## References

- SBI Specification v3.0 (RVI ratified)
- RPMI v1.0 (RVI ratified)
- LWN — "Linux SBI MPXY and RPMI", 2025
- OpenSBI release notes
- MIPI SPMI v2.0 specification
