# Nebius Live Intervention

Run: `robot-full-clean-1779556360`
Instance: `computeinstance-e00vp47p03jxxtqev3`
Observed: `2026-05-24T03:52Z`

The clean instance launched successfully, but the first cloud-init runner used
the old package path `/root/eliza/packages/robot` after extracting the payload
to `/root/robot`. It also needed the sibling editable dependency at
`/root/alberta`.

Applied live fixes:

- created `/root/eliza/packages/robot -> /root/robot`
- copied local `packages/alberta` to `/root/alberta`
- restarted `/root/robot-full/run.sh` as root into
  `/root/robot-full/cloud-init-run-3.log`

Follow-up code fixes are now in the local tree:

- `scripts/prepare_end_to_end_full_training.py` defaults the remote package
  root to `/root/robot`
- cloud-init creates the compatibility symlink
- refreshed payload now includes both `robot/` and `alberta/`

Current state:

- `00_local_preflight`: complete and uploaded
- `10_nebius_train_alberta`: running
