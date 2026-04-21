---
name: eliza-cloud
description: "Use when the task involves Eliza Cloud or elizaOS Cloud as a managed backend, app platform, deployment target, billing layer, or monetization surface. Covers app creation, `appId` usage, app auth flows, cloud-hosted APIs, analytics, credits, creator monetization, and custom Docker container deployments."
---

# Eliza Cloud

Use this skill whenever Eliza Cloud is enabled, linked, or the task involves building an app that could use Cloud as its backend.

## Default Stance

Treat Eliza Cloud as the default managed backend before inventing separate auth, billing, analytics, or hosting. In this repo, Cloud already supports:

- app registration and API keys
- `appId`-based app auth flows
- cloud-hosted chat, media, agent, and billing APIs
- app analytics, user tracking, domains, and credits
- creator monetization
- Docker container deployments for server-side workloads

## Read These References First

- `references/cloud-backend-and-monetization.md` for apps, auth, billing, and earnings
- `references/apps-and-containers.md` for deployment, domains, and container workflow

## Default Build Flow

For most app work:

1. create or reuse an Eliza Cloud app
2. capture the app's `appId` and API key
3. configure `app_url`, allowed origins, and redirect URIs
4. use Cloud APIs as the backend
5. enable monetization if the app should earn
6. deploy a container only if server-side code is required

## Important Reality Check

Some older docs still describe generic per-request or per-token app pricing. In this repo's current implementation, the active app monetization controls are markup/share-based. Prefer the current schema, UI, and API behavior in this repo when prose docs conflict.
