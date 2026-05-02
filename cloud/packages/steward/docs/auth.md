# Authentication

Steward supports multiple authentication methods. Auth flows produce a **JWT** that is used for subsequent requests. Platform operators and tenant services can also authenticate using **API key headers** without going through the user auth flow.

All auth routes are mounted at `/auth`.

---

## Methods Summary

| Method | Use Case | Endpoint |
|--------|----------|----------|
| Email magic link | End users, simple onboarding | `POST /auth/email/send` + `POST /auth/email/verify` |
| Passkeys (WebAuthn) | End users, phishing-resistant | `POST /auth/passkey/register/*` + `POST /auth/passkey/login/*` |
| SIWE (Sign-In with Ethereum) | Crypto-native users | `GET /auth/nonce` + `POST /auth/verify` |
| Google OAuth | Social login | `GET /auth/oauth/google/authorize` → callback |
| Discord OAuth | Social login | `GET /auth/oauth/discord/authorize` → callback |
| JWT Bearer | Requests after any of the above flows | `Authorization: Bearer <token>` |
| API key headers | Tenant services, agents, backends | `X-Steward-Tenant` + `X-Steward-Key` |

---

## Available Providers

Query which auth methods are active on a given instance:

```http
GET /auth/providers
```

**Response:**

```json
{
  "passkey": true,
  "email": true,
  "siwe": true,
  "google": true,
  "discord": true,
  "oauth": ["google", "discord"]
}
```

`google` and `discord` are `true` when `GOOGLE_CLIENT_ID` and `DISCORD_CLIENT_ID` are configured respectively. Use this endpoint to dynamically render login UI buttons.

---

## Email Magic Link

### 1. Send a Magic Link

```http
POST /auth/email/send
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "expiresAt": "2026-04-06T00:10:00.000Z"
  }
}
```

Steward generates a 32-byte random token, stores its SHA-256 hash (10-minute TTL), and sends an email to the user with a magic link:

```
APP_URL/auth/callback/email?token=<raw_token>&email=<email>
```

In development (no `RESEND_API_KEY`), the link is printed to the console instead.

### 2. Verify the Magic Link

Your web app calls this after the user clicks the link:

```http
POST /auth/email/verify
Content-Type: application/json

{
  "token": "<raw_token_from_url>",
  "email": "user@example.com"
}
```

**Response:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "walletAddress": "0x742d35Cc..."
  }
}
```

Steward:
1. Verifies the token (hashes it, compares against stored hash, one-time use)
2. Creates or fetches the user record
3. Auto-provisions a personal tenant (`personal-{userId}`) and EVM + Solana wallets
4. Returns a 24-hour HS256 JWT

> **Note:** The in-memory token store does not survive server restarts. In production with multiple instances, configure `REDIS_URL` so tokens persist.

---

## Passkeys (WebAuthn)

Passkeys use the WebAuthn standard. The flow requires two round trips for both registration and login.

### Registration

#### Step 1: Get Registration Options

```http
POST /auth/passkey/register/options
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Response:** A WebAuthn `PublicKeyCredentialCreationOptions` object. Pass this directly to `navigator.credentials.create()`.

```json
{
  "challenge": "base64url-encoded-challenge",
  "rp": { "name": "Steward", "id": "steward.fi" },
  "user": {
    "id": "base64url-user-id",
    "name": "user@example.com",
    "displayName": "user@example.com"
  },
  "pubKeyCredParams": [...],
  "timeout": 60000,
  "attestation": "none"
}
```

#### Step 2: Verify Registration

```http
POST /auth/passkey/register/verify
Content-Type: application/json

{
  "email": "user@example.com",
  "response": {
    "id": "credential-id",
    "rawId": "base64url...",
    "response": {
      "clientDataJSON": "base64url...",
      "attestationObject": "base64url..."
    },
    "type": "public-key"
  }
}
```

**Response:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "walletAddress": "0x742d35Cc..."
  }
}
```

Steward stores the credential in the `authenticators` table and provisions wallets on first registration.

### Login

#### Step 1: Get Authentication Options

```http
POST /auth/passkey/login/options
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**Response:** A WebAuthn `PublicKeyCredentialRequestOptions` object. Pass this to `navigator.credentials.get()`.

#### Step 2: Verify Authentication

```http
POST /auth/passkey/login/verify
Content-Type: application/json

{
  "email": "user@example.com",
  "response": {
    "id": "credential-id",
    "rawId": "base64url...",
    "response": {
      "clientDataJSON": "base64url...",
      "authenticatorData": "base64url...",
      "signature": "base64url..."
    },
    "type": "public-key"
  }
}
```

**Response:** Same shape as registration verify — returns JWT + user.

Steward updates the authenticator counter on each login to prevent replay attacks.

**WebAuthn configuration** (set via environment variables):

| Variable | Default | Description |
|----------|---------|-------------|
| `PASSKEY_RP_NAME` | `"Steward"` | Relying party display name |
| `PASSKEY_RP_ID` | `"steward.fi"` | Relying party domain (must match the domain where credentials are registered) |
| `PASSKEY_ORIGIN` | `"https://steward.fi"` | Expected origin for verification |

---

## SIWE (Sign-In with Ethereum)

Sign-In with Ethereum allows users to authenticate using their existing Ethereum wallet.

### Step 1: Get a Nonce

```http
GET /auth/nonce
```

**Response:**

```json
{
  "nonce": "abc123xyz..."
}
```

Nonces expire in 5 minutes.

### Step 2: Construct and Sign the SIWE Message

On the client, build the SIWE message and sign it with the user's wallet (e.g., MetaMask, RainbowKit):

```typescript
import { SiweMessage } from "siwe";

const message = new SiweMessage({
  domain: window.location.host,
  address: userAddress,
  statement: "Sign in to Steward",
  uri: window.location.origin,
  version: "1",
  chainId: 1,
  nonce: nonce,
});

const messageString = message.prepareMessage();
const signature = await wallet.signMessage(messageString);
```

### Step 3: Verify the Signature

```http
POST /auth/verify
Content-Type: application/json

{
  "message": "<prepared SIWE message string>",
  "signature": "0x..."
}
```

**Response for existing user:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "address": "0x742d35Cc...",
  "tenant": {
    "id": "t-742d35cc",
    "name": "0x742d...5f2b"
  }
}
```

**Response for new user** (includes one-time API key):

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "address": "0x742d35Cc...",
  "tenant": {
    "id": "t-742d35cc",
    "name": "0x742d...5f2b",
    "apiKey": "stw_abc123..."
  }
}
```

> **Save the `apiKey`** from the new-user response. It is shown only once. This key can be used for subsequent API calls using the header-based auth method.

---

## JWT Sessions

All auth flows return a **24-hour HS256 JWT** signed with `STEWARD_JWT_SECRET` (or `STEWARD_MASTER_PASSWORD` as a fallback — configure a separate secret in production).

### JWT Payload

```json
{
  "address": "0x742d35Cc...",
  "tenantId": "t-742d35cc",
  "userId": "usr_abc123",
  "email": "user@example.com",
  "iat": 1712345678,
  "exp": 1712432078,
  "iss": "steward"
}
```

### Using the JWT

Include the token in the `Authorization` header:

```http
GET /auth/session
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

**Response:**

```json
{
  "authenticated": true,
  "address": "0x742d35Cc...",
  "tenantId": "t-742d35cc",
  "email": "user@example.com",
  "userId": "usr_abc123"
}
```

### Refresh Tokens

All auth flows return both a short-lived JWT (`token`) and a long-lived refresh token (`refreshToken`).

- JWT: 24 hours
- Refresh token: 30 days (rotated on every use — old token is invalidated, new one issued)

#### Refresh an Access Token

```http
POST /auth/refresh
Content-Type: application/json

{
  "refreshToken": "<refresh_token>"
}
```

**Response:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "new-refresh-token...",
  "expiresIn": 86400,
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "walletAddress": "0x742d35Cc..."
  }
}
```

Refresh tokens are one-time use. The response always includes a new `refreshToken` — store it and discard the old one.

#### Revoke a Specific Refresh Token

Sign out from a specific session or device:

```http
POST /auth/revoke
Content-Type: application/json

{
  "refreshToken": "<refresh_token>"
}
```

**Response:**

```json
{ "ok": true }
```

#### Revoke All Sessions

Sign out from all devices (revokes every refresh token for the authenticated user):

```http
DELETE /auth/sessions
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

**Response:**

```json
{ "ok": true }
```

### Logout

```http
POST /auth/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

For a clean logout: call `POST /auth/revoke` with the refresh token to invalidate the session server-side, then discard both tokens client-side. The JWT remains technically valid until its 24h expiry, so server-side revocation via `POST /auth/revoke` is strongly recommended.

---

## API Key Authentication (Tenant-Scoped)

For backend services, agents, and automated pipelines, use tenant API key headers instead of JWTs:

```http
POST /agents
X-Steward-Tenant: my-tenant-id
X-Steward-Key: stw_abc123...
Content-Type: application/json
```

Both headers are required. The key is validated using a timing-safe PBKDF2 hash comparison.

**When does `tenantId` come from the JWT vs. headers?**

- If `Authorization: Bearer <token>` is present, `tenantId` is extracted from the JWT payload.
- If JWT is absent, both `X-Steward-Tenant` and `X-Steward-Key` are required.

---

## Agent-Scoped JWT

For agents that should only be able to sign transactions for a specific agent ID, generate a scoped token:

```http
POST /agents/{agentId}/token
X-Steward-Tenant: my-tenant
X-Steward-Key: stw_abc123...
```

**Response:**

```json
{
  "ok": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiJ9..."
  }
}
```

This token has an `agentScope` claim in the JWT payload. When used for vault operations, the API verifies that the requested `agentId` matches the scope — an agent cannot sign transactions for a different agent using this token.

---

## OAuth (Google and Discord)

Steward supports Google and Discord as social login providers. Configure them by setting the required environment variables:

| Variable | Provider | Required |
|----------|----------|----------|
| `GOOGLE_CLIENT_ID` | Google | Yes |
| `GOOGLE_CLIENT_SECRET` | Google | Yes |
| `DISCORD_CLIENT_ID` | Discord | Yes |
| `DISCORD_CLIENT_SECRET` | Discord | Yes |
| `APP_URL` | Both | Yes (for redirect URIs) |

### OAuth Flow

#### Step 1: Redirect to Provider

```http
GET /auth/oauth/google/authorize?redirectUri=https://your-app.com/auth/callback
```

Or for Discord:

```http
GET /auth/oauth/discord/authorize?redirectUri=https://your-app.com/auth/callback
```

Steward generates a CSRF state token, stores it in the challenge store (5-minute TTL), and redirects the user to the provider's authorization page.

#### Step 2: Handle the Callback

After the user authorizes, the provider redirects to Steward's callback URL. Steward validates the state, exchanges the code for an access token, fetches the user's profile, and redirects to your `redirectUri` with tokens:

```
https://your-app.com/auth/callback?token=eyJhbG...&refreshToken=<refresh>
```

#### Alternative: Token Exchange (SPAs)

For single-page apps that handle the OAuth redirect themselves:

```http
POST /auth/oauth/google/token
Content-Type: application/json

{
  "code": "<authorization_code_from_provider>",
  "redirectUri": "https://your-app.com/auth/callback"
}
```

**Response:**

```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "refreshToken": "...",
  "expiresIn": 86400,
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "walletAddress": "0x742d35Cc..."
  }
}
```

#### Callback URI Configuration

Register the following callback URI with your OAuth provider:

- Google: `{APP_URL}/auth/oauth/google/callback`
- Discord: `{APP_URL}/auth/oauth/discord/callback`

---

## Rate Limits

All auth endpoints are rate-limited per IP to prevent brute-force and enumeration attacks. These limits apply on top of the global API rate limit (100 requests / 60 seconds per IP).

| Endpoint | Limit | Window | Notes |
|----------|-------|--------|-------|
| `POST /auth/email/send` | 5 requests | 60 seconds | Prevents magic link spam |
| `POST /auth/email/verify` | 10 requests | 60 seconds | One-time token; rate limit is a secondary guard |
| `POST /auth/passkey/register/options` | 10 requests | 60 seconds | |
| `POST /auth/passkey/register/verify` | 10 requests | 60 seconds | |
| `POST /auth/passkey/login/options` | 10 requests | 60 seconds | |
| `POST /auth/passkey/login/verify` | 10 requests | 60 seconds | Prevents credential stuffing |
| `GET /auth/nonce` | 20 requests | 60 seconds | |
| `POST /auth/verify` (SIWE) | 10 requests | 60 seconds | |
| `GET /auth/oauth/:provider/authorize` | 10 requests | 60 seconds | |
| `POST /auth/oauth/:provider/token` | 10 requests | 60 seconds | |
| `POST /auth/refresh` | 20 requests | 60 seconds | Higher limit for token rotation |
| `POST /auth/revoke` | 10 requests | 60 seconds | |
| `DELETE /auth/sessions` | 5 requests | 60 seconds | |

Rate limit responses return HTTP `429 Too Many Requests` with a `Retry-After` header:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 45
Content-Type: application/json

{ "ok": false, "error": "Rate limit exceeded" }
```

---

## Platform Key Authentication

Operators running multi-tenant deployments (e.g., Milady Cloud) can authenticate with a platform key that grants cross-tenant access:

```http
GET /platform/tenants
X-Steward-Platform-Key: platform_key_value
```

Platform keys are configured via the `STEWARD_PLATFORM_KEYS` environment variable (comma-separated list of keys). Platform routes are separate from tenant routes and can read/write across all tenants. Guard this key carefully.
