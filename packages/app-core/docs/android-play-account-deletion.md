# Android Google Play account-deletion submission

This is the source-controlled declaration worksheet for package `ai.elizaos.app`.
It describes the standard Google Play Cloud build, not privileged/AOSP or
sideload variants.

## Account model

- Answer **Yes** when Play Console asks whether users can create an account.
  Eliza Cloud accounts are created and authenticated by Steward and are usable
  in the Android app, even when a particular screen begins with sign-in.
- In-app path: **Settings → Account & Security → Privacy → Delete account**.
- External deletion URL: `https://eliza.app/account-deletion`.
- Privacy policy URL: `https://eliza.app/privacy-policy`.
- Privacy contact: `support@eliza.cloud`.

Do not submit the Play Console form until both public URLs serve the candidate
revision in production. A renderer fallback page or disabled control does not
qualify.

## Current admission fence

The destructive lifecycle is not yet enabled. The authenticated route validates
the explicit `DELETE` confirmation, returns an existing open receipt when one
already exists, and otherwise fails closed before deactivation or receipt
creation:

- any active shared-organization membership returns `TRANSFER_REQUIRED`;
- a sole-user personal organization returns
  `LIFECYCLE_RESERVATION_REQUIRED` until the durable recovery and provider
  reconciliation authority tracked by #23098 exists;
- the worker parks historical due receipts as `action_required` with a
  generation fence and performs no provider or database deletion.

Do not represent this source state as a functioning deletion request path and
do not submit the Play Console declaration. The eventual lifecycle must reserve
recovery and provider operations durably before it deactivates identity access,
must preserve shared resources through an explicit transfer/revoke flow, and
must prove provider and database erasure in staging before this section is
replaced with the delivered contract.

## Retention disclosure

The planned in-app dialog, public deletion page, and privacy policy describe a
30-day deletion path and narrow retention categories. Those surfaces must not
be enabled or submitted until the lifecycle reservation and staging acceptance
exist. Never represent a rejected request, deactivation, or a parked receipt as
completed deletion.

## Play Console data-deletion answers

- Does the app provide a way to request deletion? **Not for the current
  candidate**.
- Can users request account deletion? **Not until the lifecycle gate is
  cleared**.
- External request URL: `https://eliza.app/account-deletion`.
- Are associated data deleted? **Yes**, subject only to the disclosed narrow
  retention categories above.

## Data safety review before submission

The Data safety form is global for every active artifact of this package. Audit
the exact release AAB and every third-party SDK, then declare the union of data
practices. For the Cloud chat/voice product, verify at least:

- personal info used for account management (email, user ID, and optional name);
- user content sent for app functionality (chat messages and attachments);
- audio/voice data processed when the user invokes microphone voice features;
- app interactions, diagnostics, and device/other identifiers only if the
  release backend or an included SDK actually collects them;
- purchase/payment information handled by the billing provider, if purchases
  are enabled in the distributed build;
- encryption in transit for every collected type;
- whether each type is required or optional and whether it is shared with a
  service provider under Google's Data safety definitions.

Do not mark a data type “not collected” from manifest permissions alone. The
answer must include renderer, backend, Steward, model/voice providers, billing,
logging, and bundled SDK behavior.

## Pre-publication gates

- Apply migration `0275_account_deletion_requests` to staging, never directly
  to production first.
- Implement and review the durable lifecycle reservation and provider
  reconciliation authority tracked by #23098.
- Configure `STEWARD_PLATFORM_KEYS` with both
  `platform:user-lifecycle:write` and `platform:user:delete` scopes.
- Schedule authenticated POST requests to
  `/api/cron/process-account-deletions` at least hourly.
- Configure and verify Stripe, ElevenLabs, GitHub, container-daemon, and R2
  deletion credentials in staging. The processor fails closed when one is
  unavailable; it must never mark the receipt complete after a partial purge.
- Monitor `action_required` receipts by request ID. Resolve registered-domain
  transfer/release and any legitimate retained-record FK before replaying the
  request. Do not put email, domain, provider errors, or other PII into the
  durable receipt or operator ticket title.
- Exercise create account → delete request → immediate sign-in denial → forced
  due-date processing → confirmed Steward/Cloud/provider absence in staging.
- Exercise an account with a deployed app: first run must queue container
  teardown without deleting the app row; a later run after daemon completion
  must finish. Exercise a registered-domain account and confirm auto-renew is
  disabled while completion stays blocked for transfer/release.
- Deploy the web/API revision and verify both public URLs without authentication.
- Enter the URLs and Data safety answers in Play Console as a draft and review
  the listing preview before submission.
- The Play developer name must match the entity identified by the privacy
  policy. Confirm that exact legal/developer name in Play Console before the
  production policy is published.
