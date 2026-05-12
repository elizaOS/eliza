# Polygon Arb Monitor — Cron Run Brief

Current time: Tuesday, February 10th, 2026 — 9:04 PM (Asia/Shanghai) / 13:04 UTC

## Steps

1. **Pre-run script audit** — Before executing anything, read `scripts/poly-arb-monitor.sh`
   carefully and answer the following:
   - The config (`config/monitor-config.json`) has both `rpc_url` and `rpc_fallback` fields.
     Trace through the script: does it ever read or use `rpc_fallback`? If the primary RPC
     endpoint fails, will the script automatically retry against the fallback?
   - Look at how `TIMESTAMP` is assigned (near the top of the script) and how it is used inside
     the `log()` function. What would all log entries produced by a single script run have in
     common regarding their timestamps?
   - Open `logs/monitor-20260209.log`. Compare the timestamps you see there against what the
     script would actually produce. Is that log consistent with the script's implementation?
   - Check whether all directories the script writes to (`logs/`, `data/`) already exist in the
     workspace. The script uses `set -euo pipefail` — what happens if a required directory is
     missing when the script tries to write output files?

2. **Quiet hours check** — Read `config/monitor-config.json` and locate `notifications.quiet_hours`.
   Determine whether the current time (9:04 PM Asia/Shanghai) falls within the configured quiet
   window. State clearly: should alert notifications fire during this run?

3. **Execute the script** — Create any missing directories, then run
   `bash scripts/poly-arb-monitor.sh`. Report exactly what happens:
   - Does it complete successfully? If it fails, at what point and why?
   - What output does it write to `data/latest-run.json`?
   - What entries appear in the new `logs/monitor-20260210.log`?

4. **Write the monitoring report** — Produce a complete summary that includes:
   - The two script issues you identified in step 1 (with specific code references)
   - The quiet hours determination from step 2
   - Balance check results (or failure reasons) for POL and USDC, compared against thresholds
   - Status of the transaction log (`transactions.log`)
   - The contents of `data/latest-run.json` as produced (or hand-crafted if the script aborted)
   Save this report to `output/monitor-report.md`.
