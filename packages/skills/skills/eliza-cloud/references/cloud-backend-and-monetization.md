# Eliza Cloud Backend And Monetization

## Why Use Cloud As The Backend

When Cloud is enabled, it already gives the app most of the backend primitives agents usually try to reinvent:

- authentication
- API keys
- usage tracking
- credits and billing
- analytics
- domains
- app users
- creator earnings

For app work, the default assumption should be that Cloud is the backend unless there is a specific reason not to use it.

## App As The Integration Unit

The core unit is an app record.

Current app fields in this repo include:

- `id` / `appId`
- `name`
- `app_url`
- `allowed_origins`
- `website_url`
- `contact_email`
- deployment status and production URL
- monetization fields

Creating an app yields a unique API key and an app identifier. Use the app identifier for frontend/browser-facing flows and keep the API key on trusted server paths.

## User Auth Flow

The existing app auth flow expects:

- `app_id`
- `redirect_uri`
- optional `state`

The user signs into Eliza Cloud, the app is validated, and the user is redirected back with a token. This means users logging into the app can use Eliza Cloud as the backend identity and service layer instead of a separate auth stack.

## Billing And Credits

Cloud already exposes:

- credit balance APIs
- billing summary
- checkout / top-up flows
- payment methods
- billing history

In Eliza, billing is intended to stay inside the app where possible, with hosted URLs treated as fallback.

## Current App Monetization Model In This Repo

The app monetization implementation currently centers on:

- `monetization_enabled`
- `inference_markup_percentage`
- `purchase_share_percentage`
- `platform_offset_amount`
- `total_creator_earnings`

The UI describes this as:

- creators earn from inference markups
- creators earn a share when users buy app credits
- users pay app-specific credits

So when an agent builds an app on Cloud, it should understand that app usage can be monetized directly instead of treated as pure cost.

## Redeemable Earnings

Redeemable earnings in this repo explicitly include:

- app creator earnings
- agent creator earnings
- MCP creator earnings
- affiliate and revenue-share flows

That means apps, public agents, and MCP products can all participate in monetized Cloud flows.

## Affiliate And Marked-Up Usage

The Cloud UI also includes affiliate markup flows where a code can add markup to usage and credit top-ups. This is separate from per-app monetization, but it reinforces the same principle: Cloud is designed to let builders earn on top of platform usage rather than only consume credits.

## Source Of Truth When Docs Drift

Prefer these implementation surfaces:

- `eliza/cloud/packages/db/schemas/app-billing.ts`
- `eliza/cloud/packages/db/schemas/apps.ts`
- `eliza/cloud/packages/db/schemas/redeemable-earnings.ts`
- `eliza/cloud/packages/ui/src/components/apps/app-monetization-settings.tsx`
- `eliza/cloud/packages/ui/src/components/apps/app-earnings-dashboard.tsx`
- `eliza/cloud/packages/ui/src/components/auth/authorize-content.tsx`
