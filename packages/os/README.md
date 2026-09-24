# @elizaos/os

Operating-system image and installer tooling. Current distribution development lives in
the separate elizaOS/os repository.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/os build  # build
bun run --cwd packages/os test   # tests
```

Release-script tests (`test:release`) require e2fsprogs (`mkfs.ext4` and
`debugfs`) on `PATH` for real Android partition-image fixtures.

The retained release tools use canonical JSON fixtures mirrored from
[`elizaOS/os` at `735afc708eb3`](https://github.com/elizaOS/os/tree/735afc708eb3e7a76050c0c918c916bb5545b0bf/packages/os/release).
Preserve hashed policy metadata verbatim; its historical proving command is
part of the signed digest, not a current script entrypoint.
