# Protected production-operations runner

This Terraform root reserves one always-idle GitHub Actions runner host in the
existing production Hetzner project. It is not a general CI machine: it runs no
public pull-request code, no Eliza agents, no Forgejo workload, and no Docker
node. The GitHub runner group and protected `production` environment restrict
execution to explicitly selected manual workflows.

## Security boundary

- Terraform creates only the VM, tight SSH firewall, verified runner binary,
  unprivileged service account, cleanup hooks, and systemd sandbox.
- GitHub registration tokens never enter Terraform variables, plans, state,
  cloud-init, logs, or Hetzner metadata.
- The organization runner group must be named `prod-ops`, allow only selected
  repositories, and restrict workflow access to exact `refs/heads/main` paths.
- A persistent runner is acceptable here only because untrusted PR workflows
  cannot target the group. Rebuild the host after suspected compromise.

## Provision

1. Set the protected production variables `PROD_OPS_OPERATOR_SSH_KEY` and
   `OPERATOR_INGRESS_CIDRS`. Review the server type and the recurring price in
   the Terraform plan before approval.
2. Dispatch `Infrastructure` from `main` with component `prod-ops`, environment
   `production`, operation `plan`; review the exact artifact, then apply it.
3. As an elizaOS organization owner, create the group and bind only the selected
   workflows:

   ```bash
   repo_id=$(gh api repos/elizaOS/eliza --jq .id)
   gh api --method POST orgs/elizaOS/actions/runner-groups \
     -f name=prod-ops \
     -f visibility=selected \
     -F allows_public_repositories=true \
     -F restricted_to_workflows=true \
     -F selected_repository_ids[]="$repo_id" \
     -f selected_workflows[]='elizaOS/eliza/.github/workflows/prod-ops-runner.yml@refs/heads/main' \
     -f selected_workflows[]='elizaOS/eliza/.github/workflows/slophub-cutover.yml@refs/heads/main'
   ```

4. Wait for cloud-init, create a short-lived organization registration token,
   and send it over the encrypted SSH session without placing it in argv:

   ```bash
   runner_ip=$(terraform output -json runner | jq -r .ipv4)
   registration_token=$(gh api --method POST orgs/elizaOS/actions/runners/registration-token --jq .token)
   printf '%s\n' "$registration_token" | ssh "runner-admin@$runner_ip" \
     'sudo /usr/local/sbin/configure-prod-ops-runner'
   unset registration_token
   ```

5. Dispatch `Prod Ops Runner / doctor` from `main`. The proof must show one
   online `prod-ops` runner and no agent, Forgejo, Caddy, or Docker workload.

The protected environment controls who may approve a production job; runner
group workflow restrictions control which YAML may reach the host. Both gates
are required.
