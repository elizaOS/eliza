# Private Pilot Bootstrap

This runbook bootstraps the first Eliza Hub pilot repository after the staging
stack is deployed. Keep the pilot private until the owner explicitly approves a
public launch. Do not paste real tokens, private hostnames, database output, or
mirrored private data into this repository.

Use this for the first `elizaos/eliza` mirror, then repeat the same pattern for
additional agent-owned repositories.

## Prerequisites

- The staging stack is running behind TLS with Forgejo at `${FORGEJO_ROOT_URL}`.
- `deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh` passes.
- Merge Steward is reachable at `${MERGE_STEWARD_URL}`.
- The steward bot exists as `${FORGEJO_STEWARD_USERNAME}`.
- A private `${FORGEJO_STEWARD_TOKEN}` is stored only in the host secret store
  and private `.env`.
- A private `${FORGEJO_WEBHOOK_SECRET}` is stored only in the host secret store
  and private `.env`.
- `MERGE_STEWARD_API_TOKEN` or Eliza Cloud OIDC operator auth is available for
  steward control API calls.
- The target Forgejo API schema has been checked at
  `${FORGEJO_ROOT_URL}swagger.v1.json` or `${FORGEJO_ROOT_URL}api/swagger`.

Forgejo accepts API tokens through `Authorization: token ...` or
`Authorization: Bearer ...`. Use the narrowest token that can finish the
operation. Repository-specific tokens are good for normal repo and issue work,
but initial mirror, hook, team, and branch-protection setup can require a
repository-admin or one-time operator token. Revoke bootstrap-only tokens after
verification.

## Environment

Set these in the operator shell on the staging host. Values shown here are
non-secret examples.

```bash
export FORGEJO_ROOT_URL="${FORGEJO_ROOT_URL:?set in private env}"
export MERGE_STEWARD_URL="${MERGE_STEWARD_URL:?set in private env}"
export FORGEJO_BOOTSTRAP_TOKEN="${FORGEJO_BOOTSTRAP_TOKEN:?set in operator shell}"
export MERGE_STEWARD_CONTROL_TOKEN="${MERGE_STEWARD_API_TOKEN:?set in private env}"

export ELIZA_HUB_REPO_OWNER=elizaos
export ELIZA_HUB_REPO_NAME=eliza
export ELIZA_HUB_REPO="${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}"
export ELIZA_UPSTREAM_GIT_URL=https://github.com/elizaos/eliza.git
export ELIZA_TARGET_BRANCH=main
export ELIZA_REQUIRED_CHECKS='["runner-smoke / smoke"]'
export ELIZA_TRUSTED_AGENT_IDS='["agent-codex","agent-docs"]'
```

For private upstreams, use a short-lived upstream import token through
`auth_token` in the migration payload. Do not put that token in the repository
URL, shell history, logs, or committed evidence.

## Automated Bootstrap

Use the pilot bootstrap script as the primary operator entrypoint. It is
dry-run by default, writes non-secret evidence, and only mutates Forgejo or
Merge Steward when `--apply` or `PILOT_BOOTSTRAP_DRY_RUN=false` is explicit.

```bash
PILOT_BOOTSTRAP_DRY_RUN=true \
PILOT_BOOTSTRAP_EVIDENCE_OUT="$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json" \
deployment/hetzner-staging/scripts/pilot-bootstrap.mjs

PILOT_BOOTSTRAP_EVIDENCE_OUT="$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json" \
deployment/hetzner-staging/scripts/pilot-bootstrap.mjs --apply
```

The script verifies the Forgejo API schema, creates or verifies the private
pull mirror, creates or verifies the steward webhook, creates or updates target
branch protection, upserts the Merge Steward repository policy, syncs the
trusted pilot agent identities, checks repository protection, and verifies the
project board, work dashboard, and merge queue surfaces. The checked-in
examples below remain the low-level reference for the API payloads the script
drives. The applied receipt is the production-gate source artifact for the
private `githubMigration` evidence block; dry-run receipts are deliberately
rejected for cutover.

## Mirror The Repository

Create the pull mirror before the repository exists. Forgejo pull mirrors are a
creation-time choice; do not create a normal repo and try to convert it later.

```bash
jq -n \
  --arg clone_addr "$ELIZA_UPSTREAM_GIT_URL" \
  --arg repo_owner "$ELIZA_HUB_REPO_OWNER" \
  --arg repo_name "$ELIZA_HUB_REPO_NAME" \
  '{
    clone_addr: $clone_addr,
    repo_owner: $repo_owner,
    repo_name: $repo_name,
    service: "github",
    mirror: true,
    mirror_interval: "10m",
    private: true,
    issues: true,
    labels: true,
    milestones: true,
    pull_requests: true,
    releases: true,
    wiki: false,
    lfs: true
  }' \
| curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- \
  "${FORGEJO_ROOT_URL}api/v1/repos/migrate"
```

Verify the mirror exists and the default branch is present:

```bash
curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}"

curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}/branches/${ELIZA_TARGET_BRANCH}"
```

Leave push mirrors disabled for the pilot unless there is an explicit rollback
or dual-write plan. A push mirror can overwrite the remote destination.

## Create The Steward Webhook

Create one signed repository webhook after Merge Steward is healthy. The steward
endpoint accepts Forgejo webhook payloads at `/api/webhooks/forgejo`; if the
reverse proxy exposes the steward at `/steward/`, use
`${MERGE_STEWARD_URL}/api/webhooks/forgejo`.

```bash
jq -n \
  --arg url "${MERGE_STEWARD_URL}/api/webhooks/forgejo" \
  --arg secret "$FORGEJO_WEBHOOK_SECRET" \
  '{
    type: "forgejo",
    active: true,
    branch_filter: "*",
    events: [
      "push",
      "pull_request",
      "pull_request_review",
      "issue_comment",
      "status"
    ],
    config: {
      url: $url,
      content_type: "json",
      secret: $secret
    }
  }' \
| curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}/hooks"
```

Then verify the hook exists without printing the secret:

```bash
curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}/hooks" \
| jq '[.[] | {id, type, active, events, url: .config.url}]'
```

## Protect The Target Branch

Configure Forgejo branch protection before allowing agent PRs onto the repo.
Status check names must match the workflow job contexts that Forgejo records.
Use `${FORGEJO_ROOT_URL}api/swagger` on the target instance if the branch
protection schema changes between Forgejo major versions.

```bash
jq -n \
  --arg rule_name "$ELIZA_TARGET_BRANCH" \
  --argjson status_check_contexts "$ELIZA_REQUIRED_CHECKS" \
  '{
    rule_name: $rule_name,
    enable_push: false,
    enable_push_whitelist: true,
    push_whitelist_usernames: [],
    push_whitelist_teams: [],
    enable_status_check: true,
    status_check_contexts: $status_check_contexts,
    block_on_outdated_branch: true,
    block_on_rejected_reviews: true,
    dismiss_stale_approvals: true,
    required_approvals: 1,
    require_signed_commits: false,
    apply_to_admins: true
  }' \
| curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}/branch_protections"
```

Verify the live rule:

```bash
curl --fail-with-body \
  -H "Authorization: token ${FORGEJO_BOOTSTRAP_TOKEN}" \
  "${FORGEJO_ROOT_URL}api/v1/repos/${ELIZA_HUB_REPO_OWNER}/${ELIZA_HUB_REPO_NAME}/branch_protections" \
| jq '[.[] | {rule_name, enable_status_check, status_check_contexts, required_approvals, apply_to_admins}]'
```

## Add A Trusted Runner Smoke Workflow

Before runner evidence can pass, the pilot repository needs a trusted workflow
on the target branch. Add `.forgejo/workflows/runner-smoke.yml` to the mirrored
repo or set `RUNNER_SMOKE_REPO`, `RUNNER_SMOKE_WORKFLOW`, and
`RUNNER_SMOKE_REF` to the trusted smoke repo.

```yaml
name: runner-smoke

on:
  workflow_dispatch:
  push:
    branches:
      - main

jobs:
  smoke:
    runs-on: docker
    steps:
      - name: Check runner context
        run: |
          test -n "$FORGEJO_ACTIONS"
          test -n "$FORGEJO_REPOSITORY"
          test -n "$FORGEJO_RUN_ID"
```

Run it once on the private runner, then generate runner evidence:

```bash
RUNNER_SMOKE_REPO="$ELIZA_HUB_REPO" \
RUNNER_SMOKE_WORKFLOW=runner-smoke.yml \
RUNNER_SMOKE_REF="$ELIZA_TARGET_BRANCH" \
RUNNER_SMOKE_DISPATCH=true \
RUNNER_EGRESS_REVIEWED=true \
RUNNER_SECRET_EXPOSURE_REVIEWED=true \
deployment/hetzner-staging/scripts/runner-evidence.sh
```

Do not run untrusted PR jobs on the runner until branch protection, required
checks, secret exposure, egress, and isolation evidence all pass.

## Register Repository Policy

Forgejo branch protection protects Git. Merge Steward repository policy tells
agents how this repo can enter the queue.

```bash
jq -n \
  --arg repo "$ELIZA_HUB_REPO" \
  --arg branch "$ELIZA_TARGET_BRANCH" \
  --argjson required_checks "$ELIZA_REQUIRED_CHECKS" \
  --argjson trusted_actors "$ELIZA_TRUSTED_AGENT_IDS" \
  '{
    policy: {
      repo: $repo,
      queueMode: "batched",
      protectedBranches: [$branch],
      requiredChecks: $required_checks,
      trustedActors: $trusted_actors,
      allowForks: false,
      policy: {
        maxBatchSize: 4,
        requireStackDependencyOrder: true,
        requireWorkReservation: true,
        requireWorkItem: true,
        requireVerifiedAgentRunReceipt: true
      }
    }
  }' \
| curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  -H "Content-Type: application/json" \
  -d @- \
  "${MERGE_STEWARD_URL}/api/repo-policies"
```

Verify policy and live protection agree:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/repo-policies/item?repo=${ELIZA_HUB_REPO_OWNER}%2F${ELIZA_HUB_REPO_NAME}"

curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/repository-protection?repo=${ELIZA_HUB_REPO_OWNER}%2F${ELIZA_HUB_REPO_NAME}&targetBranch=${ELIZA_TARGET_BRANCH}&requireLive=true"
```

Keep `MERGE_STEWARD_WORKER_ENABLED=false` and
`MERGE_STEWARD_INTEGRATION_EXECUTION_ENABLED=false` until the repository
protection audit, runner evidence, rollout drill, and production gate pass.

## Register Agent Identities

Strict live merge policy should reject unknown agents. Seed only the agents that
Eliza Cloud is allowed to run in this private pilot.

```bash
jq -n \
  --argjson agent_ids "$ELIZA_TRUSTED_AGENT_IDS" \
  '{
    agents: [
      $agent_ids[] as $id
      | {
          id: $id,
          displayName: $id,
          source: "eliza-cloud",
          status: "active",
          metadata: {
            pilot: true
          }
        }
    ],
    registeredBy: "eliza-cloud-operator"
  }' \
| MERGE_STEWARD_API_TOKEN="$MERGE_STEWARD_CONTROL_TOKEN" \
  node services/merge-steward/src/cli.js agent-identities sync "$MERGE_STEWARD_URL"
```

Verify the active registry:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/agent-identities?status=active"
```

## Verify Board And Queue Surfaces

Eliza Hub does not depend on Forgejo native Projects for the Project 12 style
Kanban workflow. The steward computes agent-aware board and work surfaces that
Eliza Cloud can render without reverse-engineering Git events.

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/project-board?repo=${ELIZA_HUB_REPO_OWNER}%2F${ELIZA_HUB_REPO_NAME}&emptyColumns=true"

curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/work-dashboard?repo=${ELIZA_HUB_REPO_OWNER}%2F${ELIZA_HUB_REPO_NAME}"

curl --fail-with-body \
  -H "Authorization: Bearer ${MERGE_STEWARD_CONTROL_TOKEN}" \
  "${MERGE_STEWARD_URL}/api/merge-queue?repo=${ELIZA_HUB_REPO_OWNER}%2F${ELIZA_HUB_REPO_NAME}"
```

Before enabling live merge execution, run the full post-deploy verifier and the
safe rollout drill:

```bash
MERGE_STEWARD_SMOKE_REPO="$ELIZA_HUB_REPO" \
MERGE_STEWARD_SMOKE_AGENT=agent-codex \
deployment/hetzner-staging/scripts/post-deploy-check.sh

MERGE_STEWARD_SMOKE_REPO="$ELIZA_HUB_REPO" \
deployment/hetzner-staging/scripts/merge-queue-rollout-drill.sh
```

## Pilot Exit Criteria

- Pull mirror exists and syncs the target branch.
- Public local registration is locked and Eliza Cloud SSO smoke passed.
- Steward webhook delivery succeeds and unsigned delivery is rejected.
- Branch protection requires the smoke check and at least one approval.
- Runner smoke evidence passes on an isolated private runner.
- `POST /api/repo-policies` policy matches live Forgejo protection.
- `GET /api/agent-identities?status=active` contains only approved pilot agents.
- Project board, work dashboard, and merge queue APIs return the pilot repo.
- `deployment/hetzner-staging/scripts/post-deploy-check.sh` passes.
- `deployment/hetzner-staging/scripts/merge-queue-rollout-drill.sh` passes.
- `deployment/hetzner-staging/scripts/release-gate.sh` passes.

Only after those checks pass should operators consider enabling live integration
execution, worker claiming, or broader agent access.
