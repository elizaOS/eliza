# Boot ROM release evidence

The executable reset ROM artifacts are produced by:

```sh
sh fw/boot-rom/build.sh
```

The build emits:

- `build/boot-rom/e1_reset_rom.elf`
- `build/boot-rom/e1_reset_rom.bin`
- `build/boot-rom/e1_reset_rom.hex`
- `build/boot-rom/e1_reset_rom.manifest.json`

`scripts/check_boot_rom.py` rebuilds these files, verifies the executable
artifact bounds, and checks that the manifest hashes match the current source,
linker script, ELF, binary, and hex files.

## Claim boundary

The manifest is release evidence for the reset ROM artifacts only. It does not
claim that the ROM is wired into the CPU wrapper, loaded by RTL, or exercised by
QEMU, Renode, Verilator, or hardware.

Remaining release blockers:

- CPU integration must consume `build/boot-rom/e1_reset_rom.hex` or an
  equivalent generated ROM image.
- A simulator or hardware transcript must prove the reset vector reaches the ROM
  and either hands off to the configured next-stage address or halts in the WFI
  trap loop on invalid handoff state.
