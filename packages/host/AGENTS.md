# @elizaos/host

Shared HTTP lifecycle and application configuration for explicit host composition.

Keep the protocol barrel browser-safe. Hosts own authentication and lifecycle;
core must not depend on this package. Preserve boot singleton identity and
non-initializing environment reads.

Build and validation: [README.md](README.md).
