# PMC firmware (`fw/pmc/`)

Target: **Ibex RV32IMC** management core on the AON island.

## Layout

```
fw/pmc/
  include/
    pmc.h               - shared types, register map
    rpmi.h              - RPMI v1.0 frame format
    dvfs.h              - DVFS table format
  src/
    main.c              - boot + scheduler loop
    rpmi_server.c       - RPMI v1.0 frame parser, service dispatcher
    dvfs_arbiter.c      - DVFS table lookup + AVFS merge
    pmic_sequencer.c    - external PMIC power-up/down sequence
    spmi.c              - SPMI v2.0 master bit-bang
    i2c.c               - I2C-FM-plus fallback
    thermal_policy.c    - DTS throttle ladder
    droop_telemetry.c   - droop counter aggregation
    secure_boot.c       - OPNPHN01 Ed25519 + SHA-256 image verification
```

## Build

The PMC firmware is built separately from the SoC RTL using the riscv-none-elf
toolchain in `external/xpack-riscv-none-elf-gcc-*`. Each translation unit is
deliberately small and headers are self-contained so the skeleton can be
compiled and linted independently of the Ibex sources.

```
make -C fw/pmc        # planning_only target; release_blocked
```

## Secure boot

`secure_boot.c` links the OPNPHN01 verifier (`fw/boot-rom/secure/`) and rejects
any image that fails magic, header-version, payload-hash, key-ladder,
revocation, Ed25519-signature, rollback, or lifecycle checks. The expected root
key hash and security state are delivered by the RoT over the mailbox
(`pmc_rot_read_security_state`), which fails closed until that binding lands.

## Release blockers

- Ibex source pin not committed to repo `external/` manifest.
- Linker script for AON SRAM not authored.
- RoT mailbox security-state binding (`pmc_rot_read_security_state`) not landed;
  verification fails closed until it is.
- DVFS tables (`docs/pd/dvfs-tables/`) are placeholders only.

## Cross-references

- Architecture: `docs/pd/power-management-firmware.md`
- Rail plan: `docs/pd/rail-plan-2028.yaml`
- Mailbox register map: `rtl/power/power_pkg.sv` `PMC_REG_*`
- AVFS contract: `docs/pd/avfs.md`
- Droop contract: `docs/pd/droop-detection.md`
