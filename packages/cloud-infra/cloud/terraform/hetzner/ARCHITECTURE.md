# Hetzner Control Plane vs Data Plane

eliza Cloud runs on a two-tier Hetzner Cloud setup. This doc nails down the
split so we stop treating manually-created VMs as "infrastructure-by-prayer".

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Tier 1 — Control plane (static, 1-2 VMs, Terraform)        │
│                                                              │
│   eliza-1   (Hetzner cpx21, fsn1)             │
│     ├── eliza-provisioning-worker  (systemd, queue consumer)│
│     ├── eliza-agent-router         (systemd, HTTP routing)  │
│     ├── headscale                  (VPN mesh)               │
│     ├── cloudflared tunnel         (public ingress)         │
│     ├── nginx                      (reverse proxy)          │
│     └── (optional: grafana/prometheus)                      │
│                                                              │
│   Lifecycle: long-lived. Replaced on demand, not autoscaled.│
│   Cost: ~€5/mo per VM (cpx21).                              │
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
| **State**            | Has local state (headscale DB, cloudflared creds) | Stateless |
| **Failure mode**     | Page someone           | Replace automatically     |
| **Cost predictability** | Fixed monthly       | Elastic                   |
| **What lives here**  | Orchestrator, routing, monitoring | Just Docker + agents |

The split prevents the "control plane melts with the data plane during a
traffic spike" failure mode. Pulling sandboxes off the data plane is the
autoscaler's job; the orchestrator that issues drain commands must stay up
to coordinate it.

## Code ↔ infrastructure mapping

| Component | Code | Infra |
|---|---|---|
| Control plane VM | [`packages/scripts/cloud/admin/daemons/provisioning-worker.ts`](../../../../scripts/cloud/admin/daemons/provisioning-worker.ts) | [Terraform: `control-plane/`](./control-plane/) |
| Agent router | [`packages/scripts/cloud/admin/daemons/agent-router.ts`](../../../../scripts/cloud/admin/daemons/agent-router.ts) | systemd unit on control-plane VM |
| Data plane autoscaler | [`packages/cloud-shared/src/lib/services/containers/node-autoscaler.ts`](../../../../cloud-shared/src/lib/services/containers/node-autoscaler.ts) | Hetzner Cloud API at runtime |
| Sandbox provisioning | [`packages/cloud-shared/src/lib/services/docker-sandbox-provider.ts`](../../../../cloud-shared/src/lib/services/docker-sandbox-provider.ts) | SSH from control plane to data plane |

## Naming convention

| Layer | Prefix | Example | Where it's set |
|---|---|---|---|
| Control plane VM | `eliza-<n>` | `eliza-1` | Terraform `hcloud_server.control_plane` |
| Data plane node (NEW) | `eliza-core-<hex>` | `eliza-core-38ea87b1` | [`generateNodeId()`](../../../../cloud-shared/src/lib/services/containers/node-autoscaler.ts) |
| Data plane node (LEGACY) | `milady-core-<n>` | `milady-core-1` | DEPRECATED — see [Legacy migration](#legacy-milady-core-migration) |

## Legacy `milady-core-*` migration

Pre-2026-05 the data plane was 6 manually-created `milady-core-*` VMs (Hetzner
cpx32 in fsn1) inserted by-hand into `docker_nodes` with `capacity = 100`.
By 2026-05-22:

- All 6 cores were `status: offline` (SSH health-check failing for weeks)
- Several user sandboxes still ran on the underlying Docker daemons
- The cloud autoscaler couldn't account for them

Migration 0132 (`0132_legacy_milady_cores_disable.sql`) flips them to
`enabled = false` + fixes `capacity = 8`. This:

1. Removes them from autoscaler capacity decisions
2. Stops the health-check noise
3. Lets the autoscaler spin up replacement `eliza-core-<hex>` nodes on demand

Existing sandboxes keep running until next restart. On user-triggered
restart / recreate, the daemon provisions them on a fresh autoscaled core.

Once `SELECT SUM(allocated_count) FROM docker_nodes WHERE node_id LIKE 'milady-core-%'`
is `0`, ops can:

```bash
# 1. Delete the Hetzner Cloud servers (one-time, via Hetzner console or):
hcloud server delete milady-core-1
hcloud server delete milady-core-2
# ... etc.

# 2. Drop the DB rows:
DELETE FROM docker_nodes WHERE node_id LIKE 'milady-core-%';
```

## Followups (not in this initial PR)

- [ ] Terraform module for headscale state (preauth keys, ACLs)
- [ ] Terraform module for the cloudflared tunnel (currently created by-hand)
- [ ] Terraform-apply GitHub workflow (`infra/**` path filter)
- [ ] Move the 4 remaining cron paths off the orphan
      `container-control-plane` service onto the daemon-queue pattern
      (`pool-replenish`, `pool-health-check`, `pool-image-rollout`,
      `deployment-monitor`). Once done, retire the
      `packages/cloud-services/container-control-plane/` package entirely.
- [ ] Raise Hetzner Cloud server limit (open ticket) to enable autoscale
      past the default cap of ~10 servers per account.

## Operator runbook

See [`control-plane/README.md`](./control-plane/README.md)
for the step-by-step:

- Bootstrap a brand-new control-plane VM
- Import the existing production VM into Terraform
- Verify state, plan, apply
