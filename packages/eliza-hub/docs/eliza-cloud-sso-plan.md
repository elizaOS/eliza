# Eliza Cloud / Steward SSO Plan

## Goal

Users should sign in through Eliza Cloud once, then open the private Forgejo staging instance without a separate account flow. Forgejo remains the Git system of record; Eliza Cloud / Steward owns identity, policy, and agent context.

## Roles

- Eliza Cloud / Steward: OpenID Connect issuer and policy source.
- Forgejo: OIDC relying party named `elizacloud`.
- Merge Steward: service client that uses a narrow Forgejo bot token and validates Eliza Cloud issued identity where needed.

## OIDC Provider Requirements

Eliza Cloud / Steward should expose:

- issuer URL: `${ELIZA_CLOUD_OIDC_ISSUER_URL}`
- discovery URL: `${ELIZA_CLOUD_OIDC_DISCOVERY_URL}`
- authorization, token, userinfo, and JWKS endpoints through discovery
- authorization code flow for Forgejo
- signed ID tokens with stable `sub`
- scopes: `openid email profile groups`

Register this Forgejo redirect URI with the OIDC client:

```text
${FORGEJO_ROOT_URL}user/oauth2/${FORGEJO_OIDC_AUTH_NAME}/callback
```

## Claim Mapping

| OIDC claim | Forgejo / Steward use | Rule |
| --- | --- | --- |
| `iss` | trusted issuer | Must exactly match `${ELIZA_CLOUD_OIDC_ISSUER_URL}`. |
| `sub` | immutable external account id | Never recycle. Do not derive from email. |
| `email` | account email | Required for human users. |
| `email_verified` | account trust gate | Require `true` before automatic account creation. |
| `preferred_username` | Forgejo username | Preferred source. Must be stable, lowercase-safe, and unique. |
| `nickname` | fallback Forgejo username | Use only if `preferred_username` is absent. |
| `name` | display name | Optional. |
| `picture` | avatar source | Optional; cache or proxy according to privacy policy. |
| `groups` | org/team intent | Treat as input to a controlled sync job, not blanket admin access. |
| `roles` | admin and steward permissions | Map only explicit allowlisted roles. |
| `tenant_id` | Eliza tenant boundary | Required before multi-tenant staging. |
| `eliza_agent_id` | agent identity | Required for agent-owned service accounts. |
| `eliza_agent_ids` | agent identity set | Optional for services that operate multiple agents. |
| `eliza_actor_id` | steward actor alias | Optional explicit actor id for approval and override audit fields. |
| `eliza_account_kind` | `human`, `agent`, or `service` | Steward policy should branch on this value. |

## Account Rules

- Disable public Forgejo registration.
- Allow automatic user creation only from the Eliza Cloud OIDC source.
- Keep one local recovery admin outside SSO and store its credential only in the server secret store.
- Do not auto-promote Forgejo admins from broad `groups` values.
- Use a separate bot account for `eliza-merge-steward`.
- Agent accounts should be visibly separate from human accounts and should use narrow tokens.
- Publish the allowed agent ids used by `eliza_agent_id` / `eliza_agent_ids`
  into the steward-managed `POST /api/agent-identities` registry. Keep
  `MERGE_STEWARD_AGENT_IDENTITY_REGISTRY` as a bootstrap seed for first boot,
  then let Eliza Cloud sync active agent rows before enabling production live
  merges with `MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY=true`.

## Forgejo Auth Source

After Forgejo is initialized with `INSTALL_LOCK = true`, add the Eliza Cloud provider from inside the Forgejo runtime or on the host with the same app.ini:

```sh
forgejo admin auth add-oauth \
  --provider=openidConnect \
  --name="${FORGEJO_OIDC_AUTH_NAME}" \
  --key="${ELIZA_CLOUD_FORGEJO_CLIENT_ID}" \
  --secret="${ELIZA_CLOUD_FORGEJO_CLIENT_SECRET}" \
  --auto-discover-url="${ELIZA_CLOUD_OIDC_DISCOVERY_URL}" \
  --scopes="openid email profile groups"
```

The corresponding environment placeholders live in `deployment/hetzner-staging/.env.example`.

For staging, prefer the checked bootstrap wrapper:

```sh
deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh
```

The wrapper is read-only by default. With `APPLY_BOOTSTRAP=true`, it creates the
local recovery admin if missing and adds the Eliza Cloud OIDC auth source. It
also checks the discovery document, confirms the steward token authenticates as
the expected service account, and verifies the Forgejo `login_source` config
against the private Eliza Cloud env without reading or printing the OIDC client
secret. Every run writes
`$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json`; production
cutover requires a read-only `APPLY_BOOTSTRAP=false` receipt.

Existing OIDC auth sources are treated as controlled config. If the bootstrap
reports config drift for provider, client ID, discovery URL, scopes, local 2FA
policy, or tenant/group claim gates, update the Forgejo source deliberately and
rerun the verifier instead of relying on name-only existence.

Forgejo production config must enable OAuth2 auto-registration for Eliza Cloud
users while keeping public local registration locked:

```ini
[oauth2_client]
ENABLE_AUTO_REGISTRATION = true
REGISTER_EMAIL_CONFIRM = false
USERNAME = nickname
ACCOUNT_LINKING = login
```

Keep `REGISTER_EMAIL_CONFIRM=false` unless SMTP is enabled and smoke-tested.
Require an Eliza tenant claim plus group mapping so auto-created users are
restricted to the Eliza Cloud issuer.

## Steward Integration

The steward should not share a human session. Use:

- Forgejo bot username: `${FORGEJO_STEWARD_USERNAME}`
- Forgejo bot token: `${FORGEJO_STEWARD_TOKEN}`
- webhook signature secret: `${FORGEJO_WEBHOOK_SECRET}`
- steward API audience: `${ELIZA_CLOUD_STEWARD_AUDIENCE}`

Forgejo webhooks should be signed and sent to the steward endpoint. The steward should reject unsigned webhooks, stale payloads, mismatched repository ids, and actions from unknown agent identities.

The steward control API can now validate Eliza Cloud bearer JWTs when
`MERGE_STEWARD_OIDC_ENABLED=true`. Configure `OIDC_ISSUER_URL`,
`OIDC_AUDIENCE`, and `OIDC_DISCOVERY_URL` or `OIDC_JWKS_URL`. Production mode
requires OIDC in addition to any static machine or break-glass API token.
Production runtime preflight requires at least one allowed claim gate from
`MERGE_STEWARD_OIDC_REQUIRED_ROLES` or
`MERGE_STEWARD_OIDC_REQUIRED_GROUPS`, plus at least one privileged operator
gate from `MERGE_STEWARD_OIDC_ADMIN_ROLES` or
`MERGE_STEWARD_OIDC_ADMIN_GROUPS`. Use admin claims only for cross-agent steward
operators. Static `MERGE_STEWARD_API_TOKEN` bearer auth remains available for
private machine and emergency operations.

For production evidence, write the read-only identity bootstrap receipt and the
private browser smoke result, then pass both files to `sso-evidence.mjs`:

```bash
ENV_FILE=deployment/hetzner-staging/.env \
APPLY_BOOTSTRAP=false \
deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh

ENV_FILE=deployment/hetzner-staging/.env \
SSO_SMOKE_OUTPUT=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs

ENV_FILE=deployment/hetzner-staging/.env \
SSO_EVIDENCE_SMOKE_JSON=$ELIZA_ARTIFACT_ROOT/sso-smoke.json \
SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON=$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json \
deployment/hetzner-staging/scripts/sso-evidence.mjs
```

The generated private JSON has this shape:

```json
{
  "ssoSmoke": {
    "issuerUrl": "https://cloud.eliza.example",
    "checkedAt": "2026-07-06T00:05:00.000Z",
    "oidcLoginSucceeded": true,
    "humanIdentitySmokePassed": true,
    "agentIdentitySmokePassed": true,
    "serviceIdentitySmokePassed": true,
    "publicRegistrationLocked": true,
    "nonIssuerRejected": true,
    "recoveryAdminLoginSucceeded": true
  }
}
```

Production gate validation records the smoke artifact path, SHA-256 digest, and
`checkedAt` timestamp in `sso.smokeEvidence`, and records the bootstrap receipt
path, SHA-256 digest, timestamp, status, and check count in
`sso.bootstrapEvidence`; keep both private JSON files available until the
release gate has passed.

The longer-lived steward coordination service is described in
[`steward-runtime-model.md`](./steward-runtime-model.md). Eliza Cloud identity
should authorize its control APIs for queue claims, approvals, human-request
answers, signals, and run-state reads.

## First Staging Checks

1. Confirm the discovery document advertises the expected issuer and JWKS.
2. Run `scripts/bootstrap-forgejo-identity.sh`; on first boot, run it once with
   `APPLY_BOOTSTRAP=true` after reviewing the private `.env`, then rerun it in
   read-only mode to catch OIDC auth source config drift.
3. Sign in as a human user with `email_verified = true`.
4. Confirm the Forgejo username comes from `preferred_username`.
5. Confirm a non-allowlisted group cannot create an admin.
6. Confirm public registration is still disabled.
7. Create the `eliza-merge-steward` bot token manually or through a controlled bootstrap job.
8. Register signed Forgejo webhooks only after the steward service is ready.
