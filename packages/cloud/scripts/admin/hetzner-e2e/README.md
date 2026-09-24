# Hetzner operator diagnostics

These scripts provision a raw Hetzner server, wait for SSH and Docker, deploy
an agent through the Cloud API, probe its bridge, and clean up the test server.
They are manually invoked diagnostics. No repository workflow schedules this
suite or its reaper, and no workflow concurrency group protects manual runs.

For managed-agent staging acceptance, use the shared-agent and dedicated-agent
lanes in [live-smoke.yml](../../../../../.github/workflows/live-smoke.yml).
Those lanes cover managed-agent acceptance and do not exercise this directory's
raw-provider server allocation and SSH bootstrap.

## Operator responsibility

Provisioning creates a billable server. Use a separate test-only Hetzner
project, token and SSH key. Do not run concurrent invocations against the same
state file. Before allocation, the provisioner removes older servers carrying
both `ci=true` and `workflow=hetzner-e2e`; malformed or untagged entries are
excluded. The reaper only runs when explicitly invoked, so its age threshold
is not a resource-lifetime or cost guarantee.

The scripts consume these environment variables directly; adding GitHub
secrets alone does not schedule or execute them:

| Variable | Purpose |
| --- | --- |
| `HCLOUD_TOKEN_CI` | Token for the isolated Hetzner project |
| `CLOUD_E2E_API_KEY` | Cloud staging API credential |
| `CI_SSH_PRIVATE_KEY` | Test-only private key used by the SSH readiness check |
| `CI_SSH_PUBLIC_KEY_ID` | Numeric Hetzner identifier of the matching public key |
| `GITHUB_RUN_ID` | Optional run identity used by labels and fallback cleanup |

Preserve the state file through teardown. If it is missing, teardown needs the
matching run identity for its label sweep. Cleanup is an explicit operator
step; never assume a scheduled reaper will remove a leftover server.

To validate without allocating resources, run the deterministic contract tests:

```bash
bun test packages/cloud/scripts/admin/hetzner-e2e/*.test.ts
```

These tests do not prove live provisioning, SSH readiness or model replies.

## Files

- `hetzner-e2e-provision.ts` — `HetznerCloudClient.createServer()`
- `hetzner-e2e-provision-diagnostic.ts` — validated failure classification and
  operator summary rendering
- `hetzner-e2e-wait-ready.ts` — SSH-poll for cloud-init + Docker
- `hetzner-e2e-deploy-agent.ts` — create + provision a trivial agent
- `hetzner-e2e-healthcheck.ts` — bounded `status.get` bridge polling across
  explicit Cloud cache-warming responses
- `hetzner-e2e-chat.ts` — one real `message.send` chat turn, judged by
  `../bridge-reply-verdict.ts` (#15616): the reply must echo the
  per-run proof token within the retry budget and must not be
  bridge-fabricated (`fallback: true`), runtime-canned (`failureKind`,
  known canned strings), or an `[echo]` parroting — so "provisioned
  but chat dead-ends" regressions (#15347) go red. Logs which bridge
  rung (conversation REST / OpenAI-compat / central-channel / …)
  produced the reply
- `hetzner-e2e-teardown.ts` — delete the server (idempotent, falls
  back to label sweep if state artifact missing)
- `hetzner-e2e-reaper.ts` — list+delete servers older than 60min
- `state-file.ts` — atomic JSON state shared between steps
