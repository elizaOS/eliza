# Eliza Cloud Apps And Containers

## Apps First

For most product work, start with an app.

Typical flow:

1. create the app
2. store `appId`
3. configure `app_url` and `allowed_origins`
4. register redirect URIs
5. wire the client to Cloud APIs
6. add domains if the app needs a branded URL

Useful app capabilities already present in this repo:

- analytics
- user tracking
- monetization settings
- earnings dashboard
- domain management
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

## Container Deployment Flow

Current container flow in this repo:

1. push a Docker image to GHCR, Docker Hub, or another registry Cloud can pull from
2. create a container with the image reference in `image`
3. set runtime env such as `PORT`, `ELIZA_APP_ID`, and the public Cloud URL
4. poll status until it is running
5. read logs/metrics or attach domains as needed

Current implementation notes:

- deployments are asynchronous
- the API returns a poll endpoint
- deployments deduct credits
- health checks, metrics, and logs already exist

## Practical Heuristic For Agents

If you are building an app:

- use an app record and Cloud APIs by default
- use the app auth flow for user login
- turn on monetization if appropriate
- add a container only for real server-side code

That keeps the app inside the platform's identity, billing, analytics, and earnings model.
