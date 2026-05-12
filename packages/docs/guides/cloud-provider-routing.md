---
title: "Cloud and provider routing"
sidebarTitle: "Cloud & routing"
description: "How Cloud connection, inference routing, BYOK, and quota usage relate."
---

# Cloud and provider routing

This page answers one question: **which stack actually runs inference for a request**, and **when Eliza Cloud quota is consumed**.

## Routing at a glance

| Cloud connected | Cloud inference | Active provider | Traffic |
|-----------------|-----------------|-----------------|---------|
| No | n/a | BYOK | BYOK |
| Yes | On | Eliza Cloud | Cloud |
| Yes | On | BYOK provider | Follows your settings (prefer turning **off** Cloud inference when you intend BYOK-only) |
| Yes | Off | BYOK provider | BYOK |

If you intend to use **only** your own keys, turn **off** Cloud inference in settings to avoid confusion—even if Cloud stays connected for account features.

## When Cloud quota is used

- **Cloud inference path** — billed against Cloud quota and policies.
- **BYOK path** — billed by your provider account; Cloud quota is not consumed for that request.
- **Connected but not on Cloud inference** — no Cloud inference charge for BYOK traffic.

## Recommended order of operations

1. Decide: **Cloud-only**, **BYOK-only**, or **mixed**.
2. Pick the primary model provider in settings.
3. For BYOK-only, disable Cloud inference explicitly.
4. If the UI asks for a restart after changes, complete it before validating behavior.

## Verification checklist

- Replies come from the model you expect.
- Cloud balance moves only when you expect Cloud inference.
- Settings show a restart prompt when required.

## Related

- [First-day setup and support](/guides/onboarding-and-support)
- [Eliza Cloud integration](/guides/cloud)
- [简体中文：Cloud 与提供商路由说明](/zh/guides/cloud-provider-routing)
