# Failure modes and recovery

The recovery table for the failures you'll actually encounter when running the SDK flow. Each row is a real failure shape, what causes it, and what you do.

## Registration failures (step 1)

| Symptom | Cause | Recovery |
|---|---|---|
| `409 name_collision` from `postApiV1Apps` | Another app on the org or globally already uses this name | Append a 6-char random base36 suffix (`Math.random().toString(36).slice(2, 8)`) and retry once. If the retry also collides, surface to the human — that's a naming conflict the agent shouldn't auto-resolve a second time. |
| `400 invalid_app_url` | The placeholder URL doesn't match the cloud's URL-format check | Use `https://placeholder.invalid` (the canonical placeholder); RFC-2606 reserves `.invalid` so it always parses but never resolves. |
| `403 quota_exceeded` on app creation | Org has hit its `apps_per_org` limit | Tell the human; they need to retire an old app or upgrade the tier. Do not silently delete an existing app. |

## Image build / push failures (step 2)

The agent's job, not the SDK's. Common shapes:

| Symptom | Cause | Recovery |
|---|---|---|
| `denied: requested access to the resource is denied` on push | Registry credentials missing or wrong scope | Ask the human to fix registry creds; pause until resolved. |
| `manifest unknown` / `403` from registry | The image tag doesn't exist (build silently failed) | Re-run the build with `--quiet=false` to see the actual error; surface that to the human if it's a Dockerfile issue. |
| Image pushes fine but container deploy fails health-check | Image's server doesn't bind to `$PORT`, or binds to `127.0.0.1` instead of `0.0.0.0` | Read `cloud.routes.getApiV1ContainersByIdLogs(id)`, find the bind line, fix the Dockerfile or server.ts. |

## Container deploy failures (step 3)

| Symptom | Cause | Recovery |
|---|---|---|
| `402 insufficient_balance` from `postApiV1Containers` | Org has zero credits AND zero earnings | Tell the human to top up at `/dashboard/billing`. There's no auto-recovery here — an agent that can't pay can't deploy. |
| Container starts but `status` stays `pending` for >5 min | Image pull is slow (large image) or scheduler is congested | Wait up to 10 min before declaring failure. Past that, pull container logs and surface. |
| Container hits `crash_loop` immediately | Image runs but exits non-zero on startup | Pull `getApiV1ContainersByIdLogs(id)`, surface the stderr to the human, pause. Common causes: missing env var, server bind issue, missing dependency in the image. |
| `403 quota_exceeded` on container deploy | Org has hit `containers_per_org` | Tell the human; they need to remove a container or upgrade. |

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
| `400 invalid_origin` | Container's `load_balancer_url` is nil because container isn't ready yet | Re-poll `getApiV1ContainersById` until `status === "running"` and `load_balancer_url` is populated, then patch. |

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
