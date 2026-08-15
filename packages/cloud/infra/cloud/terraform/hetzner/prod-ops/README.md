# Protected production-operations runners

This Terraform root reserves two independent GitHub Actions runner hosts in the
existing production Hetzner project. Each registration is ephemeral and accepts
one job. The hosts run no public pull-request code, Eliza agents, Forgejo,
Docker, or control-plane services.

This root provisions and proves capacity only. Existing production workflows
remain on GitHub-hosted runners until a separate reviewed change demonstrates
two healthy slots, clean one-job re-arming, and an exact hosted-runner rollback.

## Security boundary

- Terraform creates two replaceable VMs, a tight SSH firewall, pinned runner
  bytes, root-owned hooks, and a sandboxed service with an immutable `/opt`
  runner tree.
- Writable job state is confined to `/var/lib/eliza-prod-ops-runner`. The
  service runs once, does not restart, kills its full control group, and wipes
  state after exit. Cleanup is deliberately not performed in GitHub's
  job-completed hook because that hook runs before the runner process finishes.
- GitHub registration tokens never enter Terraform variables, plans, state,
  cloud-init, logs, or Hetzner metadata. A token is supplied interactively over
  SSH for one slot; the resulting registration is removed after one job.
- The organization runner group must be named `prod-ops`, select only the
  `elizaOS/eliza` repository, and initially allow only
  `prod-ops-runner.yml@refs/heads/main`.
- Each doctor matrix job passes the protected `production` environment before
  targeting its unique slot label.

## Provision and prove

1. Set protected production variables `PROD_OPS_OPERATOR_SSH_KEY` and
   `OPERATOR_INGRESS_CIDRS`. Review both VMs, the server type, replacement
   names, and recurring price in the Terraform plan.
2. Dispatch `Infrastructure` from `main` with component `prod-ops`, environment
   `production`, operation `plan`; review the exact bound artifact, then apply.
3. As an elizaOS organization owner, create the initially narrow group:

   ```bash
   repo_id=$(gh api repos/elizaOS/eliza --jq .id)
   gh api --method POST orgs/elizaOS/actions/runner-groups \
     -f name=prod-ops \
     -f visibility=selected \
     -F allows_public_repositories=true \
     -F restricted_to_workflows=true \
     -F selected_repository_ids[]="$repo_id" \
     -f selected_workflows[]='elizaOS/eliza/.github/workflows/prod-ops-runner.yml@refs/heads/main'
   ```

4. Wait for cloud-init. Arm each slot with a separate short-lived organization
   registration token. The token is read from standard input and is never
   persisted by Terraform:

   ```bash
   terraform output -json runners | jq -r 'to_entries[] | [.key, .value.ipv4] | @tsv'
   registration_token=$(gh api --method POST orgs/elizaOS/actions/runners/registration-token --jq .token)
   printf '%s\n' "$registration_token" | ssh "runner-admin@RUNNER_IP" \
     'sudo /usr/local/sbin/configure-prod-ops-runner'
   unset registration_token
   ```

5. Repeat with a fresh token for the second slot, then dispatch `Prod Ops
   Runner / doctor` from `main`. Both matrix jobs must run on distinct names and
   pass immutable-code, clean-state, disk, and workload-isolation checks.
6. Confirm both ephemeral registrations go offline after their one doctor job.
   Re-arm both with fresh tokens and repeat the doctor. This second pass proves
   cleanup and re-registration, not merely first-boot health.

## Replacement and routing gate

The hosts contain no durable data. Bootstrap inputs are hashed into each server
name and `create_before_destroy` permits an ordinary immutable replacement. An
operator can also force one slot through the reviewed Infrastructure plan:

```bash
terraform plan -replace='hcloud_server.prod_ops["prod-ops-1"]'
```

Do not add deployment workflows to the runner group in this change. A follow-up
may route a bounded manual workflow only after two live doctor passes establish
both slots, one-job cleanup, re-arming, external runner-log retention, and the
exact switch back to `ubuntu-24.04`. The protected environment controls who
approves a job; runner group restrictions control which workflow reaches a
host. Both gates remain required.
