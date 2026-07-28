# Runner-workspace cleanup (systemd system timer)

Schedules `packages/scripts/cloud/admin/prune-runner-workspaces.ts` (#15504) on a
host that doubles as a self-hosted GitHub Actions runner, so stale `_work`
checkouts are reclaimed on their own.

## Why this exists (#15398)

The prune tool is intentionally host-local — it says to run it from cron/systemd
on the runner host — but the repo shipped no timer, cron, or deployment wiring
for it. So it never ran: prod-2 (`eliza-prod-robot-2`, a 98 GB root) refilled to
**100%** on stale runner checkouts (51 GB) while Docker cleanup reported nothing
to reclaim, and an operator had to clear `_work` by hand (again) on 2026-07-15.
This bundle is the missing recurring call site.

The tool prunes only per-runner `_work` checkouts older than `--min-age` hours
and **refuses to delete while a `Runner.Worker` process is active** (its built-in
guard), so a scheduled run never interrupts a live CI job.

## Why system-level (not the `../systemd/` bundle)

`../systemd/` installs **user** services for one bot on a VPS and refuses root.
This is different: the runners' `_work` lives under a root-owned
`/opt/actions-runners`, so the prune must run as **root** via **system** units.

## Never interrupting a live job — two halves, both race-free

A single timer that greps for `Runner.Worker` and then deletes has a
check/use race: a runner can accept a job in the gap between the check and the
delete. So the work is split by whether the runner can currently accept a job:

| Runner state | Covered by | Why it is race-free |
|---|---|---|
| **Active** (unit running) | its own **job-completed hook** | the runner invokes it *between* jobs, in its own context, scoped to its own `_work` |
| **Inactive / orphaned** | the **timer** (idle helper) | a stopped unit cannot be handed a job, so nothing can start writing |

The timer helper skips every runner whose unit is active and says so in its
output; the hook never touches a sibling runner. The tool's built-in
`Runner.Worker` guard stays on underneath both (the scheduled path never passes
`--allow-active`).

## Layout

```
packages/deploy/runner-workspace-cleanup/
  install.sh      idempotent system installer (run as root on a runner host)
  smoke-test.sh   BEHAVIORAL contract check — drives the real tool, no host writes
  bin/
    eliza-prune-idle-runner-workspaces.sh   timer half: inactive/orphaned runners only
    eliza-runner-job-completed-hook.sh      hook half: this runner, between jobs
  units/
    eliza-runner-workspace-prune.service   oneshot + systemd containment
    eliza-runner-workspace-prune.timer     OnBootSec=15min, OnUnitActiveSec=1h
```

## Install (on a runner robot, as root)

```bash
cd /path/to/eliza            # a checkout that carries this repo
sudo ./packages/deploy/runner-workspace-cleanup/install.sh
```

The installer copies the (zero-dependency) tool and both helpers to
`/opt/eliza-runner-workspace-cleanup/`, writes their shared `cleanup.env`,
renders the units into `/etc/systemd/system/`, and enables the timer. The host
needs `bun` on root's `PATH` (or `BUN_BIN=/path/to/bun`); it does **not** need a
full workspace install or `node_modules` — the tool uses only Node built-ins.

That timer covers inactive/orphaned runners. To cover an **active** runner,
point it at the hook once (as the runner user), then restart that runner:

```bash
echo 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/eliza-runner-workspace-cleanup/eliza-runner-job-completed-hook.sh' \
  >> <runner-dir>/.env
systemctl restart actions.runner.<org>-<repo>.<agent-name>.service
```

The unit runs under `ProtectSystem=strict` with `ReadWritePaths=` limited to the
runner root, `ProtectHome=read-only` (bun commonly lives under `/root` on these
hosts, so `yes` would make it unreachable), `NoNewPrivileges`,
`SystemCallFilter=@system-service`, and a capability set trimmed to what
deleting foreign-owned files needs.

### Tunables (env at install time)

| Var | Default | Meaning |
|-----|---------|---------|
| `RUNNER_WORKSPACE_ROOT` | `/opt/actions-runners` | runners' work root |
| `PRUNE_MIN_AGE_HOURS` | `6` | minimum checkout age to prune |
| `BUN_BIN` | first `bun` on `PATH` | bun binary |

## Verify / operate

```bash
systemctl list-timers eliza-runner-workspace-prune.timer
systemctl start eliza-runner-workspace-prune.service          # run once now
journalctl -u eliza-runner-workspace-prune.service -n 50
# dry-run, no deletions:
bun /opt/eliza-runner-workspace-cleanup/prune-runner-workspaces.ts \
  --root /opt/actions-runners --min-age 6 --dry-run
```

The `.service` `ConditionPathExists=<runner root>` makes it a clean no-op on a
host that carries no runners.

## Uninstall

```bash
sudo systemctl disable --now eliza-runner-workspace-prune.timer
sudo rm -f /etc/systemd/system/eliza-runner-workspace-prune.{service,timer}
sudo rm -rf /opt/eliza-runner-workspace-cleanup
sudo systemctl daemon-reload
```
