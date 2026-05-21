# elizaOS Linux

The active elizaOS Linux distribution lives in [`elizaos/`](./elizaos/): a
single Debian-based live ISO build that targets **x86_64 (amd64), arm64, and
riscv64** from one live-build configuration.

```text
packages/os/linux/
├── README.md
├── LICENSES/
├── elizaos/                # the unified multi-arch live-build (source of truth)
└── agent/  crates/  vm/    # elizad daemon schemas + VM bundle metadata
```

Architecture is selected at build time via `ELIZAOS_ARCH`; an optional
`ELIZAOS_PROFILE=secure` overlays a privacy/hardening profile (Tor,
AppArmor, MAC randomization, amnesic tmpfs home) assembled from standard
Debian packages. There is no Tails fork: the earlier amd64 Tails-derived
variant and the separate riscv64 Debian variant were consolidated into this
one tree.

See [`elizaos/README.md`](./elizaos/README.md) for build commands, profiles,
the branding pipeline, and release-evidence flow, and
[`../CLAUDE.md`](../CLAUDE.md) for distribution channels and promotion policy.
