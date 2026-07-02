# Issue #11640: Cloud Deploy Job Concurrency

PR: #11653
Date: 2026-07-02

## Scope

`cloud-cf-deploy.yml` already serialized branch deploy workflow runs, but the
individual deploy jobs still needed job-level groups so a production API Worker,
Console, or App deploy cannot be cancelled mid-flight by a newer promote. This
PR adds job-level concurrency to:

- `deploy-api`
- `deploy-console`
- `deploy-app`

The existing `migrate-db` job-level concurrency remains unchanged.

## Validation

```text
python3 - <<'PY'
import yaml
from pathlib import Path
data = yaml.safe_load(Path(".github/workflows/cloud-cf-deploy.yml").read_text())
for name in ["migrate-db", "deploy-api", "deploy-console", "deploy-app"]:
    concurrency = data["jobs"][name].get("concurrency")
    print(name, concurrency)
    if not concurrency:
        raise SystemExit(f"{name} missing concurrency")
PY
```

Confirmed:

- `migrate-db`: `cloud-db-migrate-<production|staging>`, `cancel-in-progress: false`
- `deploy-api`: `cloud-cf-deploy-api-<production|staging>`, `cancel-in-progress: false`
- `deploy-console`: `cloud-cf-deploy-console-<pr-N|production|staging>`, PR previews cancel in progress, branch deploys do not
- `deploy-app`: `cloud-cf-deploy-app-<pr-N|production|staging>`, PR previews cancel in progress, branch deploys do not

```text
git diff --check origin/develop...HEAD
=> clean
```

## N/A

- Local workflow execution: N/A - GitHub Actions deployment concurrency cannot be faithfully executed locally.
- UI screenshots/video: N/A - workflow-only deploy behavior.
- Live model trajectory: N/A - no model, prompt, or agent behavior changed.
- Migration evidence: N/A - no schema or migration changed.
