# hetzner/control-plane — Terraform for the eliza Cloud control-plane VMs

This Terraform module manages the **persistent** Hetzner Cloud VM(s) that host
the elizaOS Cloud control-plane:

- `eliza-provisioning-worker` — pulls jobs from the `jobs` table and SSHs
  into sandbox cores
- `eliza-agent-router` — subdomain HTTP routing
- `cloudflared` — secure tunnel for `sandboxes.elizacloud.ai`
- `headscale` — VPN mesh for cross-core agent traffic

The **data plane** (the sandbox cores themselves) is **not** managed here —
those are provisioned and drained at runtime by
[`node-autoscaler.ts`](../../../../../cloud-shared/src/lib/services/containers/node-autoscaler.ts)
which talks to the Hetzner Cloud API directly. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full split.

## Prerequisites

1. **Hetzner Cloud project** with API token (`HCLOUD_TOKEN`).
2. **Cloudflare account** with API token + DNS edit on `elizacloud.ai`
   (`CLOUDFLARE_API_TOKEN`).
3. **Cloudflare R2 bucket** `eliza-terraform-state` for remote state. Generate
   an R2 API token, edit `backend-staging.hcl` / `backend-production.hcl`
   with your CF account ID, then export the R2 token as
   `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` before `terraform init`.
4. **Terraform >= 1.5.0** locally.

## Bootstrap a brand-new control-plane VM (staging)

```bash
cd packages/cloud-infra/cloud/terraform/hetzner/control-plane

# 1. Pull providers + connect remote state.
terraform init -backend-config=backend-staging.hcl

# 2. Copy + fill tfvars.
cp tfvars/staging.tfvars.example tfvars/staging.tfvars
$EDITOR tfvars/staging.tfvars

# 3. Plan + apply.
export HCLOUD_TOKEN=...
export CLOUDFLARE_API_TOKEN=...
terraform plan -var-file=tfvars/staging.tfvars
terraform apply -var-file=tfvars/staging.tfvars

# 4. Output gives you the VM IP. Copy the cloud env file into place:
scp packages/cloud-shared/.env.local root@<vm-ip>:/opt/eliza/cloud/.env.local

# 5. Trigger first deploy from GitHub Actions
#    (workflow: deploy-eliza-provisioning-worker.yml, manual dispatch).
```

## Adopt the existing production VM into Terraform

The current prod manager VM (`89.167.63.246`, a legacy hand-assigned
hostname) was created by hand in May 2026. To bring it under Terraform
without recreating it, look up the Hetzner Cloud server ID
(`hcloud server list`), then `terraform import 'hcloud_server.control_plane["1"]' <id>`
plus a `terraform import` for each existing `hcloud_ssh_key`. The first
plan after import shows the in-place rename to `eliza-1`, the new
labels, and the Cloudflare DNS record creation; `user_data` and `image`
diffs are suppressed by `lifecycle { ignore_changes }`. One-shot — never
re-run.

## What this module does NOT manage (yet)

- Headscale state (preauth keys, ACLs) — manual via `headscale` CLI.
- Cloudflared tunnels — config lives at `/root/.cloudflared/` on the VM and
  is created via `cloudflared tunnel create` one-shot.
- The systemd units — installed by `deploy-eliza-provisioning-worker.yml`
  on every push.
- The actual eliza Cloud sandbox cores (data plane) — runtime autoscale.

These are tracked as follow-ups in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md#followups).

## Cost

| Component                    | Resource    | Monthly (€) |
|------------------------------|-------------|-------------|
| 1× cpx32 (4 vCPU / 8 GB) x86 | control VM  | ~11         |
| 1× IPv4 + IPv6               | floating IP | included    |
| Cloudflare R2 state          | < 100 KB    | 0           |
| **Total per environment**    |             | **~11**     |

The default is `cpx32` since Hetzner retired `cpx21` in `fsn1`. Production VM
`eliza-1` actually runs `cax21` (ARM, ~€7/mo, manually provisioned) — flipping
prod via TF needs the cloud-init arm64 templating fix tracked as a followup.

A 2nd control-plane VM (HA, currently unused) doubles the line. The
**data-plane autoscale** cost is separate and elastic.
