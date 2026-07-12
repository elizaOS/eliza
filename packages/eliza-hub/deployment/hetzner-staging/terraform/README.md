# Eliza Hub Infrastructure

This directory declares the dedicated Hetzner host and Cloudflare DNS needed
for a private Eliza Hub staging or production deployment. It does not contain
account IDs, API tokens, passwords, Terraform state, or live hostnames.

Terraform owns these resources:

- one protected Hetzner server with a retained static IPv4 address
- one Hetzner firewall
- operator SSH keys
- reverse DNS for the static address
- a Cloudflare-managed web/API record, DNS-only by default
- a DNS-only native Git SSH record

Cloud-init creates a non-root operator, disables password and root SSH login,
installs Docker Compose, Caddy, Node.js 24, age, rclone, Fail2ban, and unattended
security updates, configures bounded Docker and Caddy logs, and prepares
`/srv/eliza-hub` plus private backup, artifact, and cache directories.

The stack is plan-only until an operator explicitly runs `terraform apply`.
The repository release gate only formats, initializes with the backend
disabled, and validates this configuration. It never plans or applies
infrastructure.

## Architecture

Use separate hostnames because Cloudflare's HTTP proxy does not carry normal
Git SSH traffic:

- `git-staging.example.invalid` routes HTTPS directly to Caddy through a
  Cloudflare-managed DNS-only record by default.
- `ssh-git-staging.example.invalid` is DNS-only and routes Forgejo SSH to port
  `2222` by default.
- Host administration remains key-only on port `22` and is restricted to the
  CIDRs in `operator_ssh_cidrs`.

Forgejo and Merge Steward remain bound to loopback behind Caddy. The host
firewall exposes only Caddy, native Forgejo SSH, and restricted operator SSH.
Native Git SSH is intentionally the only public Compose bind and must use a
different port from host administration SSH.

Keep `cloudflare_proxy_web=false` for first boot. That lets Caddy obtain and
renew a public certificate directly and avoids Cloudflare request-body limits
for Git LFS, packages, release assets, and HTTPS pushes. After direct TLS is
green, proxying can be enabled in a separately reviewed plan; Terraform then
restricts ports 80 and 443 to current Cloudflare edge CIDRs and uses
`CF-Connecting-IP`. Enable it only when the zone's upload and timeout limits
cover the repository's real traffic and certificate renewal has a tested
Cloudflare-compatible ACME or origin-certificate path. Native SSH remains
DNS-only either way.

## Credentials

Use narrowly scoped tokens and keep them out of files and shell history:

- `HCLOUD_TOKEN`: read/write access to the target Hetzner project.
- `CLOUDFLARE_API_TOKEN`: `Zone Read` and `DNS Write` for only the selected
  Cloudflare zone.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: R2 credentials restricted to
  the Terraform state bucket.

Wrangler can create the R2 state bucket, but Terraform owns DNS. Do not manage
the same DNS records with Wrangler, the dashboard, and Terraform.

```sh
npx --yes wrangler@latest r2 bucket create eliza-hub-terraform-state
```

Create `backend.hcl` and `terraform.tfvars` from the committed examples. Both
real files are ignored by Git. Replace every placeholder and use the operator's
actual public key and narrow administration CIDRs.

```sh
cp deployment/hetzner-staging/terraform/backend.hcl.example \
  deployment/hetzner-staging/terraform/backend.hcl
cp deployment/hetzner-staging/terraform/terraform.tfvars.example \
  deployment/hetzner-staging/terraform/terraform.tfvars
```

Never paste tokens into either file. Providers read their tokens from the
environment, and the S3 backend reads R2 credentials from the AWS-compatible
environment variables. The backend example enables Terraform's S3 lockfile so
concurrent writers fail closed. R2 encrypts every object at rest automatically;
the example deliberately omits the S3 `encrypt` option because R2 does not
implement that request header. Keep the state bucket private and restrict its
token to object read/write access on that bucket only.

## Validate And Plan

The validator works with either OpenTofu or Terraform and writes provider
scratch data under the user's disk-backed cache rather than `/tmp`. Use
Terraform or OpenTofu 1.10 or newer so native S3 lockfiles are supported:

```sh
deployment/hetzner-staging/scripts/validate-infrastructure.sh
```

Initialize the real remote backend and produce a saved plan:

```sh
terraform -chdir=deployment/hetzner-staging/terraform init \
  -backend-config=backend.hcl
terraform -chdir=deployment/hetzner-staging/terraform plan \
  -out="$HOME/.cache/eliza-hub/eliza-hub.tfplan"
terraform -chdir=deployment/hetzner-staging/terraform show \
  "$HOME/.cache/eliza-hub/eliza-hub.tfplan"
```

Review the exact server type, location, monthly cost, hostnames, operator CIDRs,
and resource actions before applying. Do not apply a plan containing deletes or
replacements during a normal rollout.

```sh
terraform -chdir=deployment/hetzner-staging/terraform apply \
  "$HOME/.cache/eliza-hub/eliza-hub.tfplan"
```

The server and static IP have provider-level delete protection by default. To
retire them, disable protection in a separately reviewed apply before any
destroy operation.

## First Host Check

After apply, wait for cloud-init and verify the bootstrap marker:

```sh
terraform -chdir=deployment/hetzner-staging/terraform output operator_ssh_command
ssh eliza@SERVER_IPV4 cloud-init status --wait
ssh eliza@SERVER_IPV4 test -f /var/lib/eliza-hub/bootstrap-complete
```

Use `deployment_env_overrides` from Terraform output when creating the private
host `.env`. Keep `FORGEJO_HTTP_BIND` and `MERGE_STEWARD_HTTP_BIND` on loopback,
set `FORGEJO_SSH_BIND=0.0.0.0`, and validate that deliberate public SSH bind
with `ALLOW_PUBLIC_BINDS=true` before first boot.

This infrastructure apply is not production evidence by itself. Continue with
the host preflight, applied deploy, post-deploy checks, SSO smoke tests, backup
and restore drill, isolated runner smoke workflow, GitHub migration rehearsal,
security review, and strict production gate documented in `../release/`.
