# #12081 / #8756 Launch-Hardening Status

Generated: 2026-07-03T20:46:11.104Z

This is a read-only collector. It does not deploy, approve environments, SSH to
hosts, or print secret values.

## Verdict

| Check | Status |
| Required production environment secrets exist | yes |
| Latest build-agent-image run for develop is green | no |
| Latest provisioning-worker deploy for develop is green | no |
| Fresh-agent cloud provisioning probe passed | no / not run |
| Issue closeable from this evidence alone | no |

## Develop Head

- Branch: `develop`
- SHA: `d45052676121525e6777870b4cc5e64f5152a869`

## Environment Secrets (production)

| Secret | Present | Updated At |
| SANDBOX_REGISTRY_REDIS_URL | yes | 2026-06-23T17:01:28Z |
| ELIZA_PROVISIONING_HOST | yes | 2026-06-11T20:58:52Z |
| ELIZA_PROVISIONING_SSH_KEY | yes | 2026-06-11T22:45:29Z |

## Cloud Auth Secret

| Secret | Present | Updated At | Source |
| ELIZACLOUD_API_KEY | yes | 2026-04-05T07:46:17Z | github-repo-secret-list |

## Workflows

| Workflow | Run | Status | Conclusion | Head SHA | Updated |
| Build Agent Image | https://github.com/elizaOS/eliza/actions/runs/28682554806 | pending |  | ec42f3ea2776b5ff0283cf03babda7e0bde3212b | 2026-07-03T20:42:24Z |
| Deploy Eliza Provisioning Worker | https://github.com/elizaOS/eliza/actions/runs/28682121776 | pending |  | fec6b59c675f4e36312cd2321a969950ecd62903 | 2026-07-03T20:30:43Z |

## Image

- Image: `ghcr.io/elizaos/eliza:develop`
- Digest: `sha256:54ce3645bcd3d5e23a2b06466691888a5bd656985e699984dbe3eb860b2c1a06`
- Inspect succeeded: yes

## Local Regression Check

- `provisioning-worker-env-reconcile.test.ts`: passed

## Fresh-Agent Probe

- Attempted: no. Pass `--cloud-report <path>` with `ELIZA_CLOUD_AUTH_TOKEN` available to run the real fresh-agent probe.

## Remaining

This evidence can close the #12081 operator lane only when all verdict rows are
green. If the workflow rows are still pending, cancelled, or missing, the live
operator lane has not been proven complete. If the fresh-agent probe is not run,
persistence, lean-plugin loading, and runtime reachability remain unverified.
