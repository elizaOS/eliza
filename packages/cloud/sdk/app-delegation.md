# Registered app delegation

Apps reuse the user's free Eliza Cloud identity. App subscriptions are separate
from Eliza subscriptions. A delegation credential grants only the displayed,
registered capabilities; it is not a Cloud API key or a purchase entitlement.

An app-owner organization administrator registers a confidential server client
with `POST /api/v1/apps/:appId/delegation-clients`. The JSON body contains
`redirectUris` (exact HTTPS return URIs on the app's registered origins) and
`allowedScopes`, plus a required `billingEnvironment` (`test` or `live`). Registration returns `data.clientId`, `data.clientSecret`, and
`data.revision` and `data.billingEnvironment`. Store the one-time client secret only on the app server.
`POST .../:clientId/rotate` replaces it and invalidates existing grants;
`DELETE .../:clientId` disables the client. App ownership transfer invalidates
the registration until the new owner rotates it or registers a replacement.
Rotation preserves its billing environment. To change environment, register a
new client and revoke the previous one; buyers cannot override this field.

Use `buildAppAuthorizeUrl` with `delegation: { clientId, scopes }` and a random
`state` bound to the current app browser session. Send the browser to that URL.
Cloud validates the app registration and exact redirect, displays the requested
capabilities, and requires the signed-in user to press Authorize. The caller must
verify the returned `state` before exchanging the one-time `code` on its server.

```ts
import { AppDelegationClient, buildAppAuthorizeUrl } from "@elizaos/cloud-sdk";

const delegation = new AppDelegationClient({ clientId, clientSecret });
const authorizationUrl = buildAppAuthorizeUrl({
  appId,
  redirectUri,
  state: browserSessionState,
  delegation: { clientId, scopes: ["identity", "billing:read", "billing:write"] },
});
// After verifying callback state against the same browser session:
const { data: grant } = await delegation.exchange(code, redirectUri);
const { data: user } = await delegation.identity(grant.token);
```

The server sends standard HTTP Basic client authentication and
`X-App-Delegation: <grant.token>` to `/api/v1/app-auth/delegations` endpoints.
`delegation.headers(token)` supplies both headers for the app billing client.
Billing routes independently verify app billing-account membership. Grant
lifetimes are seven days; `expiresAt` is credential expiry, not a trial end.
Reconnect through explicit consent after expiry or an authorization failure.

Supported capabilities are `identity`, `billing:read`, `billing:write`,
`google.basic_identity`, `google.gmail.triage`, `google.gmail.send`,
`google.calendar.read`, and `google.calendar.write`. Google requests additionally
require explicit `google.basic_identity` consent. `connectGoogle` takes an
explicit subset in `capabilities` and a registered `redirectUri`; it never
defaults to mail or calendar access. Follow its returned `data.authUrl` through
the existing managed Google OAuth flow. `googleConnections` returns connection
IDs and the intersection of Google and app-granted capabilities. `googleRequest`
requires a selected connection ID and a supported Google operation. Its raw
response preserves provider receipts and pagination. Apps retain responsibility
for send deduplication and fetching requested continuation pages.

`revoke(token)` invalidates one grant. A signed-in user can independently revoke
the app's entire consent with
`DELETE /api/v1/app-auth/delegations/consent?appId=<appId>`; cookie calls must pass
the existing first-party Origin and non-simple request guard. The user does not
need the app server's cooperation. Reconnection creates new consent and cannot
revive old grants or codes. Account deactivation, membership changes, app
suspension, and client revocation also deny existing grants.

Responses use `{ success: true, data }` for token, identity, and Google metadata,
and `{ success: true }` for revoke. Failures remain HTTP errors. The public
registration preview uses `{ success: true, app, scopes }` for the existing
consent screen. Client secrets, delegated tokens, and Google credentials must
never be embedded in browser configuration.
