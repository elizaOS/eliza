# hetzner/control-plane — Terraform for the eliza Cloud control-plane VMs

This Terraform module manages the **persistent** Hetzner Cloud VM(s) that host the elizaOS Cloud control plane.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```

The protected Headscale converge workflow uses canonical environment inputs:

```bash
gh workflow run arm-headscale-control-plane.yml --repo elizaOS/eliza --ref main -f environment=production -f operation=converge
```

Run deployment commands only for an authorized infrastructure change.
