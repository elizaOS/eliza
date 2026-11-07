# Cloudflare public-domain ownership

This Terraform root owns the durable browser, redirect-ingress, wildcard DNS, tunnel DNS and Worker routes, and advanced-certificate assets for the consolidated `eliza-app` deployment.

This directory is part of `packages/cloud/infra`.

No package build script is defined; this workspace is consumed from source.

Test isolated database backup/recovery from the repository root (requires PostgreSQL 16 and pgBackRest):

```bash
bun run --cwd packages/cloud/infra test:pitr
```

For tunnel cutover, retain the original `RAILWAY_TUNNEL_DNS_RECORDS_JSON` and
record import IDs. Add the active tunnel wildcard certificate to
`CANONICAL_EDGE_CERTIFICATE_PACKS_JSON`. After stopping the source, importing
its final state, and verifying the replacement, set protected
`TUNNEL_WORKER_HOSTNAME` to the replacement Worker host and review the plan.
It creates Worker routes, updates the existing apex and wildcard records in
place, and removes Railway verification records. Clearing the host restores
the original DNS inventory; restore the source owner before routing back.
