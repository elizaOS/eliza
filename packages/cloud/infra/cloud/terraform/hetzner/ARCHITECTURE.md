# Hetzner Control Plane vs Data Plane

eliza Cloud runs on a two-tier Hetzner Cloud setup. This doc nails down the
split so we stop treating manually-created VMs as "infrastructure-by-prayer".

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Tier 1 — Control plane (static, 1-2 VMs, Terraform)        │
│                                                              │
│   eliza-production-1   (Hetzner cpx32 x86, fsn1)            │
│   eliza-staging-1      (Hetzner cpx32 x86, fsn1)            │
│     ├── eliza-provisioning-worker  (systemd, queue consumer)│
│     ├── eliza-agent-router         (systemd, HTTP routing)  │
│     ├── headscale                  (VPN mesh)               │
│     ├── nginx                      (public ingress: agent-  │
│     │    router + headscale vhosts)                         │
│     └── (optional: grafana/prometheus)                      │
│                                                              │
│   Lifecycle: long-lived. Replaced on demand, not autoscaled.│
│   Cost: ~€11/mo per VM (cpx32, both envs).                  │
│   See variables.tf for the cpx21→cpx32 retirement note.     │
└──────────────────────────────────────────────────────────────┘
                              │ enqueue / SSH
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Tier 2 — Data plane (elastic, N cores, runtime autoscale)  │
│                                                              │
│   eliza-core-<hex>   (Hetzner cpx32, fsn1)                  │
│     ├── Docker daemon                                       │
│     └── eliza-sandbox containers × N                        │
│                                                              │
│   Lifecycle: created/drained by node-autoscaler.ts based on │
│   real demand. Server limit: ~25 (Hetzner default).         │
│   Cost: elastic (~€11/mo per running cpx32).                │
└──────────────────────────────────────────────────────────────┘
```

## Why two tiers

| Concern              | Control plane          | Data plane                |
|----------------------|------------------------|---------------------------|
| **Provisioning**     | Terraform (one-shot)   | Runtime API (node-autoscaler.ts) |
| **Lifecycle**        | Persistent             | Ephemeral                 |
| **State**            | Has local state (headscale DB, TLS certs) | Stateless |
| **Failure mode**     | Page someone           | Replace automatically     |
| **Cost predictability** | Fixed monthly       | Elastic                   |
| **What lives here**  | Orchestrator, routing, monitoring | Just Docker + agents |

The split prevents the "control plane melts with the data plane during a
traffic spike" failure mode. Pulling sandboxes off the data plane is the
autoscaler's job; the orchestrator that issues drain commands must stay up
to coordinate it.

## Confidential compute is not on Hetzner

Both tiers above are **non-confidential**. Hetzner ships no SEV-SNP / TDX /
memory-encryption / attestation product — the strongest isolation here is the
dedicated-vCPU `ccx` line (scheduling isolation, not cryptographic isolation; the
host can still read guest RAM). Confidential workloads (sealed model weights,
attestation-gated key release, private inference) route to **Phala dStack CVM on
Intel TDX**, never to these Hetzner VMs. See
[`CONFIDENTIAL_COMPUTE.md`](../../CONFIDENTIAL_COMPUTE.md) for the verified verdict
and the SEV-SNP/TDX hardware-attestation requirement.

## Code ↔ infrastructure mapping

| Component | Code | Infra |
|---|---|---|
| Control plane VM | [`packages/scripts/cloud/admin/daemons/provisioning-worker.ts`](../../../../../scripts/cloud/admin/daemons/provisioning-worker.ts) | [Terraform: `control-plane/`](./control-plane/) |
| Agent router | [`packages/scripts/cloud/admin/daemons/agent-router.ts`](../../../../../scripts/cloud/admin/daemons/agent-router.ts) | systemd unit on control-plane VM |
| Data plane autoscaler | [`packages/cloud/shared/src/lib/services/containers/node-autoscaler.ts`](../../../../shared/src/lib/services/containers/node-autoscaler.ts) | Hetzner Cloud API at runtime |
| Sandbox provisioning | [`packages/cloud/shared/src/lib/services/docker-sandbox-provider.ts`](../../../../shared/src/lib/services/docker-sandbox-provider.ts) | SSH from control plane to data plane |

## Naming convention

| Layer | Prefix | Example | Where it's set |
|---|---|---|---|
| Control plane VM | `eliza-<env>-1` | `eliza-staging-1`, `eliza-production-1` | Terraform `hcloud_server.control_plane` |
| Data plane node — dedicated | `eliza-core-<env>-<n>` | `eliza-core-staging-1`, `eliza-core-prod-2` | `docker_nodes` table (authoritative); `CONTAINERS_DOCKER_NODES` env only seeds it when empty |
| Data plane node — autoscaled burst | `eliza-core-<hex>` | `eliza-core-38ea87b1` | [`generateNodeId()`](../../../../shared/src/lib/services/containers/node-autoscaler.ts) at runtime |

Two distinct data-plane node shapes share the `eliza-core-` prefix:

- **Dedicated / onboarded robot nodes** carry an env-suffixed id
  (`eliza-core-{env}-N`, e.g. staging `eliza-core-staging-1`, prod
  `eliza-core-prod-2..6`) and OS hostname `eliza-{env}-robot-N`. They are
  registered in the `docker_nodes` table, which is the **authoritative** source
  of truth; the `CONTAINERS_DOCKER_NODES` env var is only a seed-when-empty.
- **Autoscaled burst nodes** carry a random hex suffix
  (`eliza-core-<hex>`) minted by `generateNodeId()` when the autoscaler spins up
  extra capacity on demand.

The legacy data-plane core names are **retired** (migration 0132,
`0132_legacy_eliza_cores_disable.sql`, disabled them and cross-env cleanup
removed the rows); they are not part of the live topology.

## Multi-project layout

Each environment lives in its **own Hetzner Cloud Project** — not just its own
state file. Projects are administrative containers in the Hetzner Cloud
console: separate API tokens, separate per-project resource quotas (5 servers
by default, 10 with KYC), separate SSH keys, separate private networks. There
is no `hcloud_project` Terraform resource — projects are management-plane only.

```
Hetzner Cloud account (one human)
├── Project "eliza-prod"      (env-scoped HCLOUD_TOKEN, 5/5 servers max)
│   ├── eliza-production-1     (control-plane, cpx32)
│   ├── eliza-core-prod-2..6   (dedicated workers, cpx32; docker_nodes table)
│   └── eliza-core-<hex>       (worker, cpx32, autoscaled burst by node-autoscaler.ts)
├── Project "eliza-staging"   (env-scoped HCLOUD_TOKEN, 5/5 servers max)
│   ├── eliza-staging-1               (control-plane, cpx32)
│   ├── eliza-core-staging-1          (dedicated worker, cpx32; docker_nodes table)
│   └── eliza-core-<hex>              (worker, cpx32, autoscaled burst)
└── Project "apps"            (repo-level HCLOUD_APPS_TOKEN, shared)
    ├── eliza-app-tenant                 (tenant Postgres — SHARED across envs; apps-shared/)
    ├── eliza-apps-node-staging-1        (apps Product-2 worker, staging; apps-data-plane/)
    ├── eliza-apps-node-production-1     (apps Product-2 worker, production; apps-data-plane/)
    └── eliza-apps-control-production-1  (apps-control daemon, production; role=apps-control)
```

The tenant DB is intentionally shared across staging + production app workers
— alpha scale, one Postgres node holds both env's per-tenant DATABASE+ROLE,
isolation is per-tenant not per-env. Its IaC lives in the dedicated
`apps-shared/` module with a single shared backend.

### Why split

- **Quota isolation** — prod can't starve staging, staging can't starve prod;
  apps untrusted-container quota is independent of agent capacity
- **Blast radius** — a leaked staging token can't delete prod resources; an
  apps-tenant-DB compromise can't reach the agent plane (separate network)
- **Cost visibility** — Hetzner billing already splits per project in the invoice
- **Apps stays simple** — Product 2 is alpha; one shared `apps` project keeps
  operator overhead low until there's real prod-Apps traffic to isolate.
  Future split into `apps-staging` + `apps-prod` is a token-and-state-file
  swap, no resource recreation.

### Token plumbing

| Where                                          | Sets                          | Used for                |
|------------------------------------------------|-------------------------------|-------------------------|
| GitHub Environment `staging`   → `HCLOUD_TOKEN`| staging project token         | terraform plan/apply on control-plane staging |
| GitHub Environment `production`→ `HCLOUD_TOKEN`| prod project token            | terraform plan/apply on control-plane prod    |
| Repo-level → `HCLOUD_APPS_TOKEN`               | apps project token (shared)   | terraform plan/apply on apps-shared + apps-data-plane (both envs) |
| Staging control-plane `/opt/eliza/cloud/.env.local` → `HCLOUD_TOKEN` | staging project token | provisioning-worker autoscaler   |
| Prod control-plane `/opt/eliza/cloud/.env.local`    → `HCLOUD_TOKEN` | prod project token    | provisioning-worker autoscaler   |

Terraform's `provider "hcloud" { token = var.hcloud_token }` block accepts the
token from either `var.hcloud_token` (tfvars / `-var`) or the `HCLOUD_TOKEN`
env var. GHA wires the env var via the environment-scoped secret.

### Migrating an existing project to a per-env split

Hetzner has **no move-resource-between-projects** API. The move is destructive:

1. **Create the new project** in console.hetzner.cloud (free, instant)
2. **Generate a token** scoped to the new project; store as the matching
   GitHub Environment secret + the matching control-plane env var
3. **Provision the new env's resources** fresh in the new project via
   terraform apply
4. **Migrate state** by recreating agents (the daemon does this on a
   `recreate` job — picks up env vars then targets the new project)
5. **Delete the old resources** from the old project; the old project becomes
   the home of the OTHER env (e.g. keep "default" as prod, new "staging"
   gets the new project)

Downtime is per-agent during recreate; control-plane is unaffected because
the daemon stays running on its own VM.

## Followups

CI for this module exists: `.github/workflows/terraform-control-plane.yml`
runs fmt + validate on PRs and plan/apply on operator dispatch
(`terraform-pages-domains.yml` covers the Cloudflare Pages-domains root).
Still open:

- [ ] Terraform module for headscale state (preauth keys, ACLs)
- [ ] Move the 4 remaining cron paths off the orphan
      `container-control-plane` service onto the daemon-queue pattern
      (`pool-replenish`, `pool-health-check`, `pool-image-rollout`,
      `deployment-monitor`). Once done, retire the
      `packages/cloud/services/container-control-plane/` package entirely.
- [ ] Raise Hetzner Cloud server limit (open ticket) — only if the
      per-project default 5 isn't enough after the multi-project split.

## Operator runbook

See [`control-plane/README.md`](./control-plane/README.md)
for the step-by-step:

- Bootstrap a brand-new control-plane VM
- Import the existing production VM into Terraform
- Verify state, plan, apply
