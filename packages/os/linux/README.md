# elizaOS Linux

The active elizaOS Linux distribution lives in
[`variants/elizaos/`](./variants/elizaos/): the single Tails-derived live USB
distribution branded and shipped as **elizaOS Live**.

```text
packages/os/linux/
├── README.md
├── LICENSES/
├── variants/elizaos/       # the only live Linux distribution source of truth
└── agent/  crates/  vm/    # elizad daemon schemas + VM bundle metadata
```

The old standalone Debian live-build tree has been removed. RISC-V support is
tracked as a contract of the elizaOS Live distro itself: the riscv64 runtime
artifact verifier, GUI package contract, and QEMU virtio-GPU boot requirements
live with the canonical Tails-derived variant.

See [`variants/elizaos/README.md`](./variants/elizaos/README.md) for build
commands, the branding pipeline, persistence/privacy behavior, and release
evidence flow, and
[`../CLAUDE.md`](../CLAUDE.md) for distribution channels and promotion policy.
