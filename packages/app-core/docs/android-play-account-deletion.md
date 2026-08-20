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

## Implemented lifecycle

1. The authenticated user types `DELETE` and submits a same-origin request.
2. Cloud persists an idempotent compliance receipt that contains internal IDs,
   timestamps, state, and a bounded error code, but no email, phone, wallet,
   chat content, or credentials.
3. Steward identity access, Cloud sessions, and user API keys are disabled
   immediately. A sole-user organization is also disabled.
4. The request is due after 30 days. A CRON-secret-protected processor claims
   rows with a database lock, deletes the Steward identity, and deletes the
   Cloud user. Last-user deletion cascades through the personal organization.
5. Interrupted claims are recovered. Failed purges retry hourly up to five
   attempts and then become `action_required` for operator resolution. The
   receipt survives user/org deletion; account identifiers are cleared on
   completion so only the request ID, timestamps, state, and bounded result
   metadata remain.
6. A sole owner of a multi-user organization must transfer ownership first;
   shared-organization content remains owned by that organization.

## Retention disclosure

The in-app dialog, public deletion page, and privacy policy all say that access
is disabled immediately and associated data is scheduled for deletion within
30 days. They also disclose narrowly limited retention for legal, tax,
transaction, fraud-prevention, and security obligations. Never represent mere
deactivation as completed deletion.

## Play Console data-deletion answers

- Does the app provide a way to request deletion? **Yes**.
- Can users request account deletion? **Yes**.
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

- Apply migration `0269_account_deletion_requests` to staging, never directly
  to production first.
- Configure `STEWARD_PLATFORM_KEYS` with both
  `platform:user-lifecycle:write` and `platform:user:delete` scopes.
- Schedule authenticated POST requests to
  `/api/cron/process-account-deletions` at least hourly.
- Exercise create account → delete request → immediate sign-in denial → forced
  due-date processing → confirmed Steward/Cloud absence in staging.
- Deploy the web/API revision and verify both public URLs without authentication.
- Enter the URLs and Data safety answers in Play Console as a draft and review
  the listing preview before submission.
- The Play developer name must match the entity identified by the privacy
  policy. Confirm that exact legal/developer name in Play Console before the
  production policy is published.
