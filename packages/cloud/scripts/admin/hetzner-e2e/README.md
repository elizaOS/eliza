# Hetzner Agent E2E

Nightly end-to-end smoke that provisions a real Hetzner cpx22 server, deploys a trivial agent via the Eliza Cloud staging API, runs a bridge-ping healthcheck plus one real chat turn (a `message.send` JSON-RPC through the production Worker bridge path, requiring a reply that echoes a per-run proof token and carries no fabrication flag), and tears everything down.

This directory is part of `.`.

Build from the repository root:

```bash
bun run --cwd . build
```

Test from the repository root:

```bash
bun run --cwd . test
```
