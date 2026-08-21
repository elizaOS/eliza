# CI runner placement policy

**Rule: GitHub Actions self-hosted runners MUST NOT run on hosts that serve as
agent docker-nodes (rows in `docker_nodes` hosting `agent-*` containers).**

## Why (incident, 2026-08-13)

Four production agent nodes (`eliza-core-prod-3/4/5/6`) each also hosted four
Actions runners. Launch-window PR volume ran Playwright browser farms on them,
pinning 12-core hosts at load 10–20. The saturation made `docker stop/rm`
exceed the deliberately bounded `STOP_CMD_TIMEOUT_MS` (25s — protects the
provisioning-worker cycle and its DB advisory lock), which cascaded:
half-failed warm-pool provisions self-fenced (`replacement_cleanup_sandbox_id`
pointing at their own container), were reaped at the reconciliation deadline,
orphaned, and drove the pool to respawn ~16 agents/hour against a target of 2 —
degrading real user onboarding provisions ("Registered Docker nodes exist but
none available", provision/health-check timeouts). A secondary defect amplified
it: the pool health sweep destroyed ready entries on a single missed 5s probe
(fixed by the probe-retry change alongside the per-cycle deletion reconcile
sweep in the provisioning worker).

Full evidence chain: elizaOS/eliza discussion #18309 (2026-08-13 comments).

## Enforcement state

Runner registrations live OUTSIDE this repo (hand-provisioned on the Hetzner
robot hosts), so this placement policy cannot be enforced by repo code today.
The systemd process-lifetime policy for those hosts IS repo-owned:
`cloud/runners/actions-runner@.service` is the canonical template unit
(`KillMode=control-group` — the previously deployed `KillMode=process` left a
stale `Runner.Listener` alive across restarts and caused the `eliza-robot-20`
`_diag/pages` collision, issue #19708), and
`cloud/runners/repair-runner-slot.sh` is the single-slot repair runbook. The
2026-08-13 remediation enforced it at three operational levels on the four
affected hosts: runner services **stopped**, **disabled** (reboot-safe, with
`/opt/actions-runners/WHY-DISABLED-20260813.md` on each box), and
**deregistered** from the repository runner registry. Re-adding CI capacity to
any agent node therefore requires a deliberate re-registration — do not, unless
the host no longer appears in `docker_nodes` or no longer hosts `agent-*`
containers.

Dedicated CI capacity: the `eliza-robot-*` runner farm (no co-located agents).
Emergency fallback if self-hosted capacity drains: set the repository variable
`HETZNER_FLEET_ONLINE=false` — every workflow lane falls back to GitHub-hosted
runners by design.

Protected production operations reserve two isolated `prod-ops` runner slots.
Each registration accepts one job, requires the protected `production`
environment, and may never accept public PR jobs or share a machine with the
general runner farm, SlopHub/Forgejo, an agent docker-node, or an Eliza
control-plane service. The provisioning and doctor workflow do not route any
existing deployment onto the pool. Routing requires separate review after both
slots pass two live arm-run-clean-rearm cycles and the hosted fallback is
proved. The reproducible hosts live in `cloud/terraform/hetzner/prod-ops/`.

## If you provision new nodes or new runners

- New agent docker-node → never install an Actions runner on it.
- New runner host → keep it out of `docker_nodes`.
- New production-operations runner → use an ephemeral one-job registration,
  place it in the `prod-ops` group, restrict that group to exact protected
  workflow paths, and keep at least two independent slots available.
- If a host must change roles, remove it from one plane before adding it to the
  other, and update this document.
