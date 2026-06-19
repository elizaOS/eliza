# U-Boot port scaffold

U-Boot starts after the Chipyard/Rocket software reference can boot OpenSBI and
expose RAM, UART, timer, and interrupt devices tied to
`sw/platform/e1_platform_contract.json`.

Repo-local command and expected output for the fail-closed scaffold:
[../bsp-scaffold-expected-output.md](../bsp-scaffold-expected-output.md).

Dependency blocker: a real U-Boot port requires a working OpenSBI handoff,
DRAM map, UART console, timer, interrupt controller, boot media, and device tree
from the CPU-capable target. Until then this directory is documentation-only and
must not be treated as boot evidence.
