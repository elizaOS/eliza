# Issue #13618 — Honest Live/Deploy Gates

## Fix

- Cloud live E2E now fails in strict contexts (push, merge_group, workflow_dispatch, schedule) when the Eliza Cloud API key is missing instead of producing a green skip.
- Scheduled/dispatch remote capability cloud smoke now fails when the capability flag is not enabled, so report-producing runs cannot silently skip.
- Provider live E2E now fails in strict contexts when all provider endpoints or required provider endpoints are missing.
- Cloud CF deploy jobs now have job-level timeouts for API, console, and app deploys.
- Worker e2e is a hard deploy gate again; `continue-on-error` was removed.
- Voice live e2e no longer soft-passes an unprovisioned runner; missing fused ASR/model assets emit an error and exit 1.

## Verification

Static validation on the patched workflow payload:

```bash
ruby -e 'require "yaml"; YAML.load_file("/tmp/eliza-13618/.github/workflows/test.yml"); YAML.load_file("/tmp/eliza-13618/.github/workflows/cloud-cf-deploy.yml"); YAML.load_file("/tmp/eliza-13618/.github/workflows/voice-live-e2e.yml"); puts "workflow yaml ok"'
rg "continue-on-error: true|Skipping to a neutral" /tmp/eliza-13618/.github/workflows/cloud-cf-deploy.yml /tmp/eliza-13618/.github/workflows/voice-live-e2e.yml /tmp/eliza-13618/.github/workflows/test.yml
```

Full CI and deploy workflow evidence must be captured on the PR branch / dispatch runs.

## Evidence Matrix

- Missing-secret strict run: pending GitHub workflow run after PR creation.
- Worker e2e seeded failure: pending deploy workflow verification.
- Killed/stalled runner timeout: pending deploy workflow verification.
- UI screenshots/video: N/A - workflow-only change.
- Real LLM trajectories: N/A - no agent/action/prompt/model behavior changed.
