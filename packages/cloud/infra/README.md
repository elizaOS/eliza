# @elizaos/cloud-infra

Infrastructure-as-code and local-dev tooling for the elizaOS Cloud stack: Kubernetes
manifests, Helm values, Terraform, Docker Compose, and shell scripts.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/infra test:pitr  # local recovery drill
```

No standalone build script is defined; this package is consumed or executed from source.
