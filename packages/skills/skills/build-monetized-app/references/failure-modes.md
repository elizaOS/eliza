# Failure modes and recovery

The recovery table for the failures you'll actually encounter when running the SDK flow. Each row is a real failure shape, what causes it, and what you do.

## Registration failures (step 1)

| Symptom | Cause | Recovery |
|---|---|---|
| `409 name_collision` from `createApp` | Another app on the org or globally already uses this name | Append a 6-char random base36 suffix (`Math.random().toString(36).slice(2, 8)`) and retry once. If the retry also collides, surface to the human — that's a naming conflict the agent shouldn't auto-resolve a second time. |
| `400 invalid_app_url` | The placeholder URL doesn't match the cloud's URL-format check | Use `https://placeholder.invalid` (the canonical placeholder); RFC-2606 reserves `.invalid` so it always parses but never resolves. |
| `403 quota_exceeded` on app creation | Org has hit its `apps_per_org` limit | Tell the human; they need to retire an old app or upgrade the tier. Do not silently delete an existing app. |

## Image failures (step 2)

You do not build or push an image — apps deploy a prebuilt, allowlisted
first-party image. These surface as deploy errors (`getAppDeployStatus().error`)
in step 3:

| Symptom | Cause | Recovery |
|---|---|---|
| `Image '<ref>' is not permitted ... outside the allowed image namespaces` | `metadata.imageTag` / `APP_DEFAULT_IMAGE` is outside the first-party `ghcr.io/elizaos/*` allowlist (`APPS_DEPLOY_IMAGE_ALLOWLIST`, fail-closed) | Use an allowlisted `ghcr.io/elizaos/*` image — the stamped template default already is. Do NOT push your own image to an arbitrary registry; that path is denied. |
| `builds from a git repo, but build-from-repo is disabled` | A repo-linked app has no prebuilt image and build-from-repo is off (no `APPS_IMAGE_REGISTRY`) | Register as a template app (`skipGitHubRepo: true`) so the first-party template image is stamped, or set an explicit allowlisted `metadata.imageTag`. |
| `No image to deploy ... set app.metadata.imageTag, or APP_DEFAULT_IMAGE` | Neither a stamped template image nor a prebuilt override resolved | Re-create the app with `skipGitHubRepo: true` (stamps the template image), or set `APP_DEFAULT_TEMPLATE_IMAGE` on the deploy backend. |

## Deploy failures (step 3)

`cloud.deployApp(appId)` kicks off the managed deploy; poll `cloud.getAppDeployStatus(appId)`.

| Symptom | Cause | Recovery |
|---|---|---|
| `503 { code: "apps_deploy_disabled" }` from `deployApp` | `APPS_DEPLOY_ENABLED` is not `1` on the Worker | The apps-deploy backend isn't armed for this environment. Report to the human; do not work around it. |
| `403` from `deployApp` | Org is not on the production deploy allowlist | Report to the human — the org must be allowlisted for apps deploy. |
| `402 insufficient_balance` | Org has zero credits AND zero earnings | Tell the human to top up at `/dashboard/billing`. There's no auto-recovery — an agent that can't pay can't deploy. |
| `getAppDeployStatus().status === "error"` | The deploy failed (image-allowlist reject, image pull, crash on boot) | Read `status.error` and surface it. There is NO per-container logs/health/metrics SDK route; the deploy status error string is the only signal. |
| `status` stuck on `pending` / `building` for >10 min | Image pull slow or scheduler congested | Wait up to ~10 min before declaring failure, then surface `status.error`. |

## Monetization configuration (step 4)

Use `PUT /api/v1/apps/<appId>/monetization` with the current camelCase schema.
Rare:

| Symptom | Cause | Recovery |
|---|---|---|
| `400 markup_out_of_range` | Markup outside the allowed bound | Cap your value at the bound and retry. |
| `404 resource_not_found` | Wrong app id or app owned by another org | Re-read the app id from the registration response; do not patch a guessed id. |

## Patch app_url + origins (step 5)

| Symptom | Cause | Recovery |
|---|---|---|
| `400 invalid_origin` | The deployed URL isn't ready yet | Re-poll `getAppDeployStatus(appId)` until `status === "ready"` and `vercelUrl` is populated (else use the app's `*.apps.elizacloud.ai` subdomain), then patch. |

## Custom domain (post-skill, optional)

If the human asks for a custom domain after deploy:

| Symptom | Cause | Recovery |
|---|---|---|
| `verified: false` on the domain after add | DNS hasn't propagated | Tell the human; verification is async and depends on their DNS provider. The skill's job is done after step 6 — domain verification is not part of the skill. |

## Auth flow failures (during user signup)

These hit AFTER the skill is complete, when users actually try to sign in to the deployed app. Not the skill's responsibility, but worth knowing:

| Symptom | Cause | Recovery |
|---|---|---|
| OAuth redirect lands on `404` at `/api/v1/app-auth/connect` | Cloud hasn't deployed the steward-sync path yet | Out of scope for this skill — it's an upstream cloud deploy issue. |
| User completes OAuth but chat returns `401 invalid_jwt` | The user's JWT shape changed between signup and request | Have the user re-sign-in. If it persists, the issue is upstream. |

## What you don't recover from

If the agent can't deploy at all (zero credits AND zero earnings) the loop has bottomed out. There's no programmatic recovery — only the human can top up. Tell them clearly:

> "I can't deploy a new app — both org credits and your redeemable earnings are zero. Top up at https://www.elizacloud.ai/dashboard/billing or earn enough on existing apps to cover the next deploy."

This is a survival-economics terminal state, not a code bug.
