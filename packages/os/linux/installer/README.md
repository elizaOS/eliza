# @elizaos/linux-installer-plan

This package is the deterministic, non-mutating planning foundation for the GNOME
installer launched from a persistent mkosi USB image.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/os/linux/installer build:native  # build
bun run --cwd packages/os/linux/installer test   # tests
```
