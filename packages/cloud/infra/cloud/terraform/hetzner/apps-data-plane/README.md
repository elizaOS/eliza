# elizaOS Cloud Apps — environment worker infrastructure

This root provisions app Docker hosts, network attachments, firewalls and
wildcard ingress for one environment. The corresponding `apps-shared` root
must first publish its network and database into that environment's state
bucket. A missing or different `environment` output stops planning before
workers can attach to that network.

Use `backend-<environment>.hcl` and the matching tfvars example with a Hetzner
apps project token and R2 state credentials scoped to that environment.
Development, staging and production each use a separate
`eliza-terraform-state-<environment>` bucket. Canonical and legacy app domains
and the cloud API origin must match the selected environment.

## Existing-fleet migration

The per-environment backends are new isolated destinations. Do not use
`terraform init -migrate-state` to move old worker ownership or the shared tenant
DB into them: that would not move data or separate projects. Keep the old fleet
and state available under its reviewed historical configuration while executing
the [database migration](../apps-shared/README.md#migration-and-admission).

Provision and verify candidate hosts before DNS cutover. Existing wildcard
records must be adopted into the intended state through an exact-ID reviewed
import and routing plan; do not delete or recreate DNS by reusable name to
resolve a duplicate-record error. Coordinate the final authority switch with
the database write fence, Caddy routes, daemon node registrations and tenant
DSNs. Preserve the old host and database until the replacement passes restore
and rollback checks.

Each planned worker receives its environment's database host and cloud API
origin. After provisioning, validate its SSH identity, kernel isolation,
per-app database access and egress policy before enabling customer workloads.
For multiple hosts, complete load balancing and route reconciliation; the
wildcard resource currently targets host 1 and does not by itself distribute
traffic across workers.

## Verification

```bash
terraform init -backend=false -input=false
terraform validate
terraform test
```

These tests exercise the actual Terraform plan and remote-state identity
postcondition with substituted providers and state transport. They prove
configuration rejection, not live project isolation, data migration or cloud
readiness. Reviewed provider plans and runtime evidence remain required.
