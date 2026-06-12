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

## Operational notes

**SSH to the CP — always by public IP, never by hostname.** The Cloudflare DNS
record (`eliza-${env}-N.elizacloud.ai`) is proxied (orange-cloud); CF does not
pass TCP/22, so `ssh root@eliza-staging-1.elizacloud.ai` silently fails. Get the
IP from terraform output:

```bash
terraform output -json control_plane_vms | jq -r '."1".ipv4'
# Or the ready-made command:
terraform output ssh_login_commands
```

**Cloudflare zone SSL mode MUST stay on "Full"** (not "Full (Strict)"). The
control-plane uses a self-signed `*.elizacloud.ai` cert; CF only accepts that
on "Full". Flipping to Strict in the CF dashboard breaks every dashboard
chat call silently with HTTP 526.

**DNS cutover is operator-gated, not automatic.** The control-plane A record
has `lifecycle.ignore_changes = [content]` so `terraform apply` never auto-
flips the IP when a new VM gets created. When the new CP is validated, flip
the record manually via the Cloudflare dashboard (preferred — no NXDOMAIN
window) or via a one-off `terraform state rm` + re-apply round-trip if you
want the new content to land back in state.

**Cloud-init changes need `terraform taint`** to land on existing VMs.
`user_data` is in `lifecycle.ignore_changes` so subsequent applies are
no-ops for an already-provisioned CP. To roll a bootstrap fix, taint the
VM and re-apply — but that wipes local state (headscale DB, cloudflared
creds, /opt/eliza checkout). Plan that out before touching prod.

**Headscale handoff on a fresh CP.** Cloud-init installs the `headscale`
package (binary, systemd unit, `/var/lib/headscale` state dir owned by the
package user) but stops the auto-started service so it doesn't bind with a
fresh empty DB. On first deploy the operator overlays the prior CP's
config + state:
```bash
# From the prior CP
ssh root@PRIOR_CP 'sudo tar czf /tmp/hs.tgz -C /var/lib/headscale db.sqlite noise_private.key'
scp root@PRIOR_CP:/tmp/hs.tgz /tmp/hs.tgz
ssh root@PRIOR_CP 'sudo cat /etc/headscale/config.yaml' > /tmp/headscale-config.yaml

# Adjust server_url for the new CP's hostname
sed -i -E 's|^server_url:.*|server_url: https://eliza-${env}-1.elizacloud.ai|' /tmp/headscale-config.yaml

# Push to NEW CP
scp /tmp/headscale-config.yaml /tmp/hs.tgz deploy@NEW_CP:/tmp/
ssh deploy@NEW_CP '
  sudo mv /tmp/headscale-config.yaml /etc/headscale/config.yaml
  sudo tar xzf /tmp/hs.tgz -C /var/lib/headscale
  sudo chown -R headscale:headscale /var/lib/headscale
  sudo systemctl enable --now headscale
'
```

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
