# riscv64 elizaOS Linux — node-agent boot evidence + root-cause (2026-05-23)

Headless qemu-virt boot of the latest completed riscv64 ISO, capturing branded
GRUB → kernel → Postgres → agent. Transcript-only evidence (no silicon claim).

## Artifacts under test
- ISO: `out/elizaos-linux-riscv64-default-20260523T222632Z.iso`
- ISO sha256: `deb12416c3109752974b037d6cf0bb945ed809d68d8649991cdcd261bcbf7a4c`
- Agent payload: node-shebang `agent-bundle.js` (bun NOT used on riscv64;
  `artifacts/riscv64/manifest.txt` → `bun_file=node-shebang-agent-bundle-no-bun`)

## QEMU
- Binary: repo qemu 10.1.5 (`packages/chip/external/xpack-qemu-riscv-9.2.4-1/bin/qemu-system-riscv64`,
  which delegates to `~/.local/cuttlefish/bin/qemu-system-riscv64`). The Debian
  system qemu 8.2.2 wedged in early kernel boot under host CPU contention and
  produced no kernel banner; qemu 10.1.5 booted the kernel within ~1 min.
- `-machine virt -cpu max -m 4096 -smp 1`, EDK2 UEFI from
  `/usr/share/qemu-efi-riscv64/`. Single vCPU chosen for faster wall-clock TCG
  boot under heavy host load.
- Evidence: `evidence/qemu_virt_boot_20260523T233556Z_node_agent_q10.json`
  Transcript: `evidence/qemu_virt_boot_20260523T233556Z_node_agent_q10.transcript.log`

## Boot stages reached (all OK, zero forbidden markers)
- RISC-V EDK2 UEFI firmware 2024.02
- Branded GRUB menu: `*elizaOS Linux (live)`, `(live, fail-safe mode)`, `Utilities...`
- Removable UEFI loader `/EFI/boot/bootriscv64.efi`, live kernel/initrd 6.12.90+deb13-riscv64
- Linux kernel boot (SBI v2.0), systemd reached target + logind
- `postgresql@17-main.service` starting
- `elizaos-firstboot-ready`
- `elizaos-kiosk.service` started (epiphany/cage kiosk)
- auto-login getty `user@debian`
- `elizaos-agent-starting` → node ran the bundle, plugins resolved (orchestrator,
  shell, anthropic, openai, sql, … loaded in ~6s)
- NO `unhandled signal 4` / SIGILL (the node path avoids the bun-riscv64 SIGILL
  that broke the earlier `071039Z` bun-path boot)

## Agent did NOT reach health — root cause (real bug, not just TCG slowness)
The agent entered a crash-restart loop (3× PGlite abort, 2× diagnostics dump,
4× agent-starting). The runtime log dumped to serial shows:

```
Info  [eliza] DATABASE_URL detected: using Postgres database
Info  [eliza] Database provider: pglite                       <-- contradiction
Error [PLUGIN:SQL] PGlite initialization failed ... Aborted(). Build with -sASSERTIONS
Error [eliza] Plugin "@elizaos/plugin-sql" crashed during init: PGlite initialization failed
```

WASM PGlite aborts on riscv64 (no WASM in this runtime) — which is exactly what
the riscv64 design intends to avoid by provisioning native Postgres
(`config/hooks/normal/0012-riscv64-agent-postgres.hook.chroot`).

Diagnosis: `packages/agent/src/runtime/eliza.ts::applyDatabaseConfigToEnv`
took the `!db?.provider && DATABASE_URL` branch (logged "DATABASE_URL detected"),
which means `config.database.provider` was UNDEFINED at runtime — i.e. the
agent did NOT load the hook-written `/var/lib/elizaos/eliza.json`
(`provider: "postgres"`). It set `POSTGRES_URL` from env, but the later DB
decision (`resolveActivePgliteDataDir` / "Database provider:" log near line 3131)
keys off `config.database?.provider ?? "pglite"` → defaulted to pglite and
attempted the WASM init → abort. Net: env says Postgres, config object says
pglite, plugin-sql obeys the config object.

Secondary issues in the same dump (do not block, but noted):
- Several core plugins `Cannot find package` / `no valid Plugin export` — the
  bare `agent-bundle.js` is not fully self-contained for these.
- `No AI provider plugin was loaded` (no API key / Cloud login in the live image).

## Fix direction (not yet implemented)
Ensure the riscv64 agent actually consumes `database.provider=postgres`:
- Make the hook write the config to the path `loadElizaConfig()` resolves for
  the `elizaos` service user (it reads `<ELIZA_STATE_DIR>/eliza.json`; verify
  `ELIZA_STATE_DIR=/var/lib/elizaos` is in scope for the node child and that the
  file is readable by user `elizaos`), OR
- Have `applyDatabaseConfigToEnv` / the DB-provider decision treat a present
  `POSTGRES_URL`/`DATABASE_URL` as authoritative `provider=postgres` (so the
  pglite WASM path is never taken when a Postgres URL is set).

The first is the more correct fix: the config object, not just env, must carry
`provider=postgres` so `resolveActivePgliteDataDir` returns null and plugin-sql
never touches PGlite on riscv64.
