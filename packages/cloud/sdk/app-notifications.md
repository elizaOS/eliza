# App subscription notifications

Cloud sends `app.subscription.updated` hints after its subscription transaction commits. A hint contains the app, registered test/live environment, billing account, product family, subscription revision, delivery ID and occurrence time. It contains no entitlement or payment authorization. Read current billing state through the app billing SDK before changing app access; event arrival order is not subscription order.

A current developer billing manager configures the endpoint through `AppBillingAdminClient`. Supply a current `clientRegistrationId`; its registered environment determines which deliveries can reach the endpoint. The HTTPS endpoint must use a registered app origin and must pass Cloud's outbound network policy. Redirects are rejected.

1. Call `configureNotifications` with `enabled: false` and the current configuration revision (null for the first configuration).
2. Call `prepareNotificationKey` with the returned revision. Install the returned signing secret in the app backend's secret store. It is returned once and is encrypted in Cloud storage.
3. Call `activateNotificationKey` with the pending key ID and its configuration revision, then enable delivery with `configureNotifications` and the new revision.
4. For rotation, install the pending key before activation. Keep the previous key available for deliveries already in flight. Select an installed key using `X-Eliza-Key-Id`; an unknown key must fail verification.

The receiver reads the raw request body and calls `verifyAppBillingNotification` from `@elizaos/cloud-sdk/app-notifications` with its configured app ID and environment, the selected secret, `X-Eliza-Timestamp`, and `X-Eliza-Signature`. Verify before parsing or reserializing the body. The SDK checks the timestamp window and exact signed bytes.

Persist the hint's delivery ID together with durable work that will read current subscription state. Return a 2xx response after accepting that work. Cloud can retry after an acknowledgement is lost; an already accepted delivery should return 2xx again. Retries preserve the delivery ID and exact body, with a fresh signature timestamp. Failed delivery remains durable with exponential backoff capped at one hour. `notificationConfig` reports pending deliveries, failures and the last successful acknowledgement. Disabling the endpoint pauses delivery without discarding the outbox.

Cloud operators register the Stripe subscription webhook endpoint using the pinned `2024-11-20.acacia` event contract. `STRIPE_WEBHOOK_SECRET` verifies the existing primary endpoint; `STRIPE_TEST_WEBHOOK_SECRET` optionally verifies a separate test endpoint and cannot authenticate live events. Existing Connect endpoint signing configuration remains supported. Subscription triggers are retained in PostgreSQL before the existing Redis queue handoff, so queue outages are recoverable by the shared cron worker.
