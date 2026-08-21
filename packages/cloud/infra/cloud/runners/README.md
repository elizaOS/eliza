# General runner-farm systemd assets

Repository-owned source of truth for the hand-provisioned `eliza-robot-*`
GitHub Actions runner farm on the Hetzner robot hosts. Registrations are still
created by an operator (see `../../RUNNER-PLACEMENT.md` — one directory per slot
under `/opt/actions-runners/runner-<N>`), but the process-lifetime policy is no
longer improvised per host.

## Files

- `actions-runner@.service` — canonical template unit for
  `/etc/systemd/system/actions-runner@.service`. `KillMode=control-group` is
  the load-bearing setting: the previously deployed `KillMode=process` left the
  old `Runner.Listener` alive across a restart, so two listeners shared one
  slot's `_diag/pages` directory and every job routed to the slot failed before
  checkout (incident elizaOS/eliza#19708, runner `eliza-robot-20` on
  `eliza-staging-robot-1`).
- `repair-runner-slot.sh` — root-run repair for one collided slot. Dry-run by
  default; `--apply` stops the slot's unit, reaps abandoned listener chains,
  preserves `_diag/pages` to a timestamped `pages.issue-19708-<UTC>` sibling,
  installs the canonical unit (backing up the old fragment), daemon-reloads,
  restarts only that slot, and fails unless exactly one listener owns it.

## Operator flow for a diagnostic-page collision

1. Keep the slot's `hetzner-robot` label absent (per-runner quarantine).
2. On the host, as root: `./repair-runner-slot.sh <slot>` (review the dry run),
   then `./repair-runner-slot.sh <slot> --apply`.
3. Route two pinned checkout + workspace-setup verification jobs to the slot
   via a dedicated verification label and inspect both job logs.
4. Only then restore `hetzner-robot`. `HETZNER_FLEET_ONLINE` is owned
   separately and is never changed by this flow.

The script installs the canonical unit whenever the deployed fragment
differs from it in any normalized line — not just on the stop policy — so a
stale fragment with the right `KillMode` but a wrong `User` or
`WorkingDirectory` is still replaced and `daemon-reload`ed.

Static invariants for these files are enforced by
`../../tests/runner-farm-static.test.ts`; the repair flow itself (dry-run
inertness, stale-unit replacement, diagnostic preservation, sibling-slot
isolation) is exercised against a fake systemd host by
`../../tests/runner-farm-repair.test.ts`. That harness is the only supported
use of the `ELIZA_RUNNERS_ROOT`, `ELIZA_RUNNER_UNIT_PATH`, and
`ELIZA_RUNNER_SETTLE_SECS` overrides; leave them unset on a real host.
