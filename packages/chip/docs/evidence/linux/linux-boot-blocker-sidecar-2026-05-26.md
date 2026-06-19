# Linux boot blocker sidecar - 2026-05-26 UTC

Scope: FireMarshal `eliza-e1-linux-smoke` userspace/initramfs inspection only.
No kernel, AP, or ISA scripts were changed.

## Findings

- Current generated-AP transcript reaches kernel initcall tracing and stops in
  the SiFive UART driver path before `uart_add`; it does not reach the kernel
  `Run /init as init process` handoff in the latest
  `build/chipyard/eliza_rocket/verilator-linux-smoke.log`.
- The preferred FireMarshal initramfs contains executable `/init`, BusyBox
  `/bin/sh`, and the copied smoke helpers:
  `/usr/bin/eliza-e1-linux-smoke`, `/usr/bin/eliza-riscv-hwprobe`, and
  `/usr/bin/e1-npu-ml-smoke`.
- `/init` is a shell script that mounts proc/sys/devtmpfs, creates `/tmp`, and
  `exec`s `/usr/bin/eliza-e1-linux-smoke`.
- The helper binaries in `sw/firemarshal/eliza-e1-linux-smoke/` are statically
  linked RISC-V Linux ELF executables, so a missing dynamic loader is not the
  likely blocker.

## Userland change

`eliza-e1-linux-smoke.sh` now treats `/proc/eliza_uart` as an optional fast
path. If the proc UART sidecar exists but rejects a write, the workload falls
back to byte writes through BusyBox `devmem` instead of exiting under `set -e`.

## Interpretation

The evidence points away from a static-init-binary or shell/initramfs packaging
failure. The next blocker is still before FireMarshal userspace: generated-AP
Linux must get past the current UART driver probe/handoff stall before the
FireMarshal `/init` and workload transcript can prove userland execution.
