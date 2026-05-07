# n8n Credential Provider — Connector Team Handoff Spec

This document is the self-contained reference for adding n8n credential auto-wiring to any Milady connector plugin.

---

## Overview

When the NL→n8n pipeline generates a workflow for a connector (e.g. "post to Slack"), it needs to attach real n8n credentials at deploy time. Without a provider, deployment fails silently with a missing-credential error.

Each connector plugin registers a **CredentialProvider** service. The n8n workflow plugin's 4-tier resolution chain calls `resolve(userId, credType)` on every registered provider and uses the first one that returns `credential_data`.

---

## The CredentialProvider Interface

```typescript
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

interface CheckCredentialTypesResult {
  supported: string[];
  unsupported: string[];
}

interface CredentialProvider {
  resolve(userId: string, credType: string): Promise<CredentialProviderResult>;
  checkCredentialTypes(credTypes: string[]): CheckCredentialTypesResult;
}
```

- Return `{ status: 'credential_data', data }` when env vars are present and valid.
- Return `null` when this provider doesn't handle that `credType`, or when env vars are missing.
- Return `{ status: 'needs_auth', authUrl }` only when you can redirect the user to OAuth.
- `checkCredentialTypes` is a fast sync check — no env reads, just which types you handle.

---

## Registration Pattern

Every credential provider must:

1. **Extend `Service`** from `@elizaos/core` with `static serviceType = 'n8n_credential_provider'`.
2. **Implement `static async start(runtime)`** returning a new provider instance.
3. **Be listed in the plugin's `services: [...]` array**.

The runtime duck-types the service — it looks for `serviceType === 'n8n_credential_provider'` and then calls `resolve()`. No import from `@elizaos/plugin-n8n-workflow` is required.

**Do NOT** import `N8N_CREDENTIAL_PROVIDER_TYPE` or types from `@elizaos/plugin-n8n-workflow`. Inline the constant string and type alias to avoid adding a compile-time dependency.

---

## Minimal Implementation Template

```typescript
// src/n8n-credential-provider.ts
import { type IAgentRuntime, Service } from '@elizaos/core';

// Inlined — do not import from @elizaos/plugin-n8n-workflow
const N8N_CREDENTIAL_PROVIDER_TYPE = 'n8n_credential_provider';
type CredentialProviderResult =
  | { status: 'credential_data'; data: Record<string, unknown> }
  | { status: 'needs_auth'; authUrl: string }
  | null;

const SUPPORTED = ['myConnectorCredType'];

export class MyConnectorN8nCredentialProvider extends Service {
  static override readonly serviceType = N8N_CREDENTIAL_PROVIDER_TYPE;
  override capabilityDescription = 'Supplies MyConnector credentials to the n8n workflow plugin.';

  static async start(runtime: IAgentRuntime): Promise<MyConnectorN8nCredentialProvider> {
    return new MyConnectorN8nCredentialProvider(runtime);
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    if (credType !== 'myConnectorCredType') return null;
    const token = this.runtime.getSetting('MY_CONNECTOR_TOKEN') as string | undefined;
    if (!token?.trim()) return null;
    return { status: 'credential_data', data: { accessToken: token.trim() } };
  }

  checkCredentialTypes(credTypes: string[]): { supported: string[]; unsupported: string[] } {
    return {
      supported: credTypes.filter((t) => SUPPORTED.includes(t)),
      unsupported: credTypes.filter((t) => !SUPPORTED.includes(t)),
    };
  }
}
```

Then in `src/index.ts`:
```typescript
import { MyConnectorN8nCredentialProvider } from './n8n-credential-provider';

const myPlugin: Plugin = {
  services: [MyConnectorService, MyConnectorN8nCredentialProvider],
  // ...
};
```

---

## Simple Token Service

Use when: connector has a static API token, no OAuth flow.

```typescript
const token = this.runtime.getSetting('MY_TOKEN') as string | undefined;
if (!token?.trim()) return null;
return { status: 'credential_data', data: { accessToken: token.trim() } };
```

## OAuth Service

Use when: connector requires OAuth 2.0. The token is typically stored in the agent config after an OAuth flow the user has already completed.

```typescript
const accessToken = this.runtime.getSetting('MY_OAUTH_ACCESS_TOKEN') as string | undefined;
const refreshToken = this.runtime.getSetting('MY_OAUTH_REFRESH_TOKEN') as string | undefined;
if (!accessToken?.trim()) return null;
return { status: 'credential_data', data: { accessToken: accessToken.trim(), refreshToken } };
```

If the OAuth flow hasn't been completed yet, return `needs_auth`:
```typescript
return { status: 'needs_auth', authUrl: 'https://your-app/oauth/start' };
```

## HTTP Header Auth (Generic)

Use when: the connector's n8n node uses `httpHeaderAuth` (LINE, Twitch, Farcaster, Bluesky, Signal, Feishu, Nextcloud).

```typescript
return {
  status: 'credential_data',
  data: { name: 'Authorization', value: `Bearer ${token.trim()}` },
};
```

## HTTP Query Auth (Generic)

Use when: the connector authenticates via a URL query parameter (BlueBubbles).

```typescript
return {
  status: 'credential_data',
  data: { name: 'password', value: password.trim() },
};
```

---

## n8n Credential Type Reference (Common)

| Service | n8n Credential Type |
|---------|---------------------|
| Discord | `discordApi`, `discordBotApi` |
| Telegram | `telegramApi` |
| Gmail | `gmailOAuth2`, `gmailOAuth2Api` |
| Slack | `slackApi`, `slackOAuth2Api` |
| WhatsApp | `whatsAppApi` |
| Matrix | `matrixApi` |
| Google Chat | `googleChatOAuth2Api` |
| Google Sheets | `googleSheetsOAuth2Api` |
| Google Calendar | `googleCalendarOAuth2Api` |
| Google Drive | `googleDriveOAuth2Api` |
| Instagram (Meta Graph API) | `facebookGraphApi` |
| Microsoft Teams | `microsoftTeamsOAuth2Api` |
| LINE | `httpHeaderAuth` (no dedicated node) |
| Twitch | `httpHeaderAuth` (no dedicated node) |
| Farcaster | `httpHeaderAuth` (no dedicated node) |
| Bluesky | `httpHeaderAuth` (no dedicated node) |
| Signal | `httpHeaderAuth` (no dedicated node) |
| Feishu/Lark | `httpHeaderAuth` (no dedicated node) |
| BlueBubbles | `httpQueryAuth` (no dedicated node) |
| Nextcloud Talk | `httpHeaderAuth` (no dedicated node) |

For 450+ additional n8n service nodes, see `defaultNodes.json` in this package — each node's `credentials[]` array lists the `name` (= cred type) and `required` flag.

---

## Advertising Credentials to the LLM

After wiring the provider, add the new cred type(s) to `ELIZA_SUPPORTED_CRED_TYPES` and `CRED_TYPE_FACTS` in:

```
eliza/packages/app-core/src/services/n8n-runtime-context-provider.ts
```

This causes the LLM to see the credential type in its generation prompt (`## Available Credentials`) and include the correct credential block in generated workflows. Without this step, the cred provider resolves but the LLM never generates a workflow that uses it.

The `CRED_TYPE_FACTS` shape:
```typescript
myCredType: {
  friendlyName: "Human-readable name",
  nodeTypes: ["n8n-nodes-base.myNodeName"],
},
```

---

## Testing Checklist

For each new connector provider:

- [ ] `resolve()` returns `credential_data` when env vars are set
- [ ] `resolve()` returns `null` for an unsupported `credType`
- [ ] `resolve()` returns `null` when env vars are unset/empty
- [ ] `checkCredentialTypes()` returns correct `supported` / `unsupported` split
- [ ] Provider is in `services: [...]` in the plugin's `index.ts`
- [ ] Cred type is in `ELIZA_SUPPORTED_CRED_TYPES` and `CRED_TYPE_FACTS`
- [ ] End-to-end: set env var → generate a workflow using that connector → confirm credential auto-attached at deploy
- [ ] End-to-end: unset env var → LLM does not advertise that connector in `supportedCredentials`

---

## Reference Implementations

| Connector | File |
|-----------|------|
| Discord | `eliza/plugins/plugin-discord/src/n8n-credential-provider.ts` |
| Telegram | `eliza/plugins/plugin-telegram/src/n8n-credential-provider.ts` |
| Slack | `eliza/plugins/plugin-slack/src/n8n-credential-provider.ts` |
| WhatsApp | `eliza/plugins/plugin-whatsapp/src/n8n-credential-provider.ts` |
| Matrix | `eliza/plugins/plugin-matrix/src/n8n-credential-provider.ts` |
| LINE | `eliza/plugins/plugin-line/src/n8n-credential-provider.ts` |
| Farcaster | `eliza/plugins/plugin-farcaster/n8n-credential-provider.ts` |
| Bluesky | `eliza/plugins/plugin-bluesky/n8n-credential-provider.ts` |

---

## Unsupported Connectors

Three connectors have no viable n8n node. See `unsupported-connectors.md` for workarounds:

- **iMessage** — macOS local-only, no API surface
- **Nostr** — no n8n community node
- **Tlon/Urbit** — no n8n node, niche platform
