# Eliza Cloud Apps And Containers

## Apps First

For most product work, start with an app.

Typical flow:

1. create the app
2. store `appId`
3. publish the custom UI with managed frontend hosting
4. choose database mode (`none` or `isolated`)
5. deploy an app-owned backend only when needed
6. configure `app_url`, `allowed_origins`, and redirect URIs
7. submit review, then enable monetization after approval
8. verify real auth/inference billing and add a domain if wanted

Useful app capabilities already present in this repo:

- analytics
- user tracking
- monetization settings
- earnings dashboard
- domain management
- managed frontend versions and rollback
- optional isolated per-app database
- one-time API key display and regeneration

## Domains

Apps can get:

- a managed subdomain
- custom domains with verification

If the task needs a production URL, prefer the existing app/domain model before inventing custom deployment plumbing.

## When To Use A Container

Use a Cloud container when the app needs backend code that cannot live purely in the browser or through the existing managed APIs.

Good reasons:

- custom server logic
- webhooks
- background jobs tied to the app
- an existing Dockerized service

Do not default to a container just to get a backend if the built-in Cloud APIs are already enough.

## App-Owned Backend Deployment Flow

For an app backend, keep the container attached to the same `appId`:

1. publish a custom prebuilt image in a platform-allowed or operator-granted namespace
2. call `POST /api/v1/apps/:id/deploy` with that explicit `image`
3. let the platform inject `ELIZA_APP_ID` and the selected app database variables
4. poll `GET /api/v1/apps/:id/deploy/status` until `READY` or `ERROR`
5. verify the authoritative production URL and `/health`

Current implementation notes:

- deployments are asynchronous
- the app deploy and status routes are the supported lifecycle surface
- the backend validates image namespaces and optional digest pinning
- the owning org's container quota and credit billing apply
- generic `/containers` is for standalone infrastructure, not a second copy of an app
- the public SDK does not currently expose per-app-container logs or metrics;
  use deploy status/error and the live health probe

## Practical Heuristic For Agents

If you are building an app:

- use an app record and Cloud APIs by default
- use the app auth flow for user login
- submit review before turning on monetization
- add a container only for real server-side code

That keeps the app inside the platform's identity, billing, analytics, and earnings model.
