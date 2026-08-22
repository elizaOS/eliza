# Mobile-store account-deletion submission contract

This is the source-controlled declaration worksheet for package `ai.elizaos.app`.
It describes the shared Cloud deletion contract consumed by the standard
Google Play and App Store builds, not privileged/AOSP or sideload variants.

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

## Current source candidate

The current source accepts a recently authenticated sole-user personal-account
request after the exact `DELETE` confirmation. Under locked user, organization,
and membership rows it creates one durable lifecycle reservation and phase
receipts, issues separate opaque status and recovery capabilities, and fences
sessions, paid work, auto-top-up, renewal, and provisioning before provider
work. Replayed requests never create a second reservation.

- Shared membership or ownership that cannot be removed safely returns the
  actionable `TRANSFER_REQUIRED` state. It never deletes shared assets, cancels
  shared billing, or leaves an organization with no active owner.
- Cancellation is nonterminal `canceling` while export revocation and Steward
  reactivation reconcile. Access remains fenced until both receipts complete;
  only terminal `canceled` restores active access.
- After the recovery boundary, a leased and generation-fenced saga inspects
  before every provider mutation and reconciles ambiguous responses rather than
  repeating them. Database erasure and identifier nulling commit atomically
  only after every required phase receipt is complete.
- Pre-reservation historical receipts still take the deliberate
  `LIFECYCLE_RESERVATION_REQUIRED` fence. That legacy guard is not request
  admission for new reservations.

This is a local production candidate, not evidence that the URLs or provider
authorities are deployed. Do not submit either store declaration until the
hosted disposable-account acceptance and publication gates below are complete.

## Retention disclosure

The in-app dialog, public deletion page, and privacy policy disclose immediate
access fencing, a 30-day recovery window, permanent deletion after that window,
and narrow legal, tax, fraud-prevention, and security retention categories.
Never represent a rejected request, `reserved`, `recovery`, `canceling`,
`scheduled`, `processing`, or `action_required` receipt as completed deletion.

## Play Console data-deletion answers

- Does the source candidate provide an in-app request path? **Yes**.
- Does the source candidate provide an external request path? **Yes**.
- External request URL: `https://eliza.app/account-deletion`.
- Are associated data deleted? **Yes**, subject only to the disclosed narrow
  retention categories above.

These are source-candidate answers only. Enter **Yes** in Play Console only
after the exact production AAB, public page, API revision, background worker,
and disposable hosted lifecycle have passed the gates below.

## Apple App Store review cross-check

Apple requires apps that support account creation to let users initiate
deletion in the app; deactivation alone is insufficient. The shared renderer
provides the initiation and exact-confirmation flow, but the exact signed iOS
artifact still requires physical review. Confirm that:

- Account & Security exposes the control without an unnecessary support-only
  detour, and any website handoff goes directly to `/account-deletion`;
- the 30-day recovery period, billing consequences, and narrow retained-record
  categories are visible before confirmation;
- Sign in with Apple token revocation is either proven in the provider saga or
  marked not applicable for the exact release; and
- subscription handling is reconciled with the release's actual App Store
  purchase model and does not permit a stale renewal to reactivate the account.

Do not claim App Store compliance from source tests alone. Apple review,
signed-device behavior, hosted provider absence, and applicable local retention
law remain separate acceptance gates.

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

- Apply the foundational `0276_account_deletion_requests` migration followed by
  lifecycle migrations `0305` through `0308` to disposable staging, never
  directly to production first. Verify the migration ledger is linear after
  upstream `0304` before promotion.
- Review the durable lifecycle reservation, cancellation reconciliation,
  export, provider saga, and atomic erasure authority tracked by #23098.
- Configure `STEWARD_PLATFORM_KEYS` with both
  `platform:user-lifecycle:write` and `platform:user:delete` scopes.
- Schedule authenticated POST requests to
  `/api/cron/process-account-deletions` at least hourly.
- Configure and verify Steward, Stripe, managed-domain, compute/container,
  GitHub/repository, connector OAuth, voice, primary object-store,
  secondary-backup, backup-spool, Vault/key-binding, and other discovered grant
  authorities in disposable staging. The processor fails closed when a required
  authority is unavailable and must never complete after a partial purge.
- Monitor `action_required` receipts by request ID. Resolve registered-domain
  transfer/release and any legitimate retained-record FK before replaying the
  request. Do not put email, domain, provider errors, or other PII into the
  durable receipt or operator ticket title.
- Exercise create account → export → delete request → immediate cross-device
  sign-in denial → cancellation and full reactivation → second request → forced
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

## Policy references

- [Google Play account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
- [Apple account-deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
