# OWNER vs AGENT — Connector Audit

Every connector in elizaOS can — in principle — be configured against two
distinct platform accounts:

- **OWNER** — the user's own account (e.g. the user's Gmail, the user's
  Discord profile, the user's iMessage). Lets the agent act on behalf of the
  user: read their inbox, see their DMs, forward an email to itself.
- **AGENT** — a separate identity the agent operates as itself (e.g. a
  dedicated agent Gmail address, a Discord bot, a Slack app). Acts under its
  own name and is subject to the platform's bot/app rules.

End-state behavior: the user forwards an email from their OWNER inbox to the
agent's AGENT inbox, and the agent receives it and responds — both sides
connected on the same platform.

The OWNER role is well-defined elsewhere: it is the entity bound to the
device during onboarding and gates privileged runtime actions (see
[`agents/owner-role.md`](../agents/owner-role.md)). This document covers the
**connector-level** OWNER/AGENT distinction — auth methods, platform
constraints, and the per-connector status of OWNER/AGENT support today.

Where the platform offers proper user OAuth (X, Google, Slack, GitHub, …),
**Eliza Cloud OAuth is the default "Log in with X" path**. Manual API-key
paste is the last-resort fallback. Where the platform forbids user-account
automation (Discord, Instagram personal, WeChat personal), OWNER mode either
relies on local-app inspection hacks (Discord CDP, iMessage `chat.db`) or is
flagged platform-impossible.

---

## Per-connector matrix

Legend: ✅ wired · ⚠️ partial / hardcoded role · ❌ missing · 🚫
platform-impossible

| Connector | AGENT today | OWNER today | Cloud OAuth | OWNER feasible | Critical gap |
|---|---|---|---|---|---|
| **Discord** (`plugin-discord`, `plugin-discord-local`) | ✅ bot token | ⚠️ macOS RPC+AppleScript + macOS CDP relaunch (port 9224) | ❌ bot-install only, NOT in generic OAuth provider registry | ⚠️ macOS today; Windows port unverified | Windows CDP port + add user-login OAuth route |
| **Telegram** | ✅ bot token | ✅ `my.telegram.org` + StringSession | 🚫 Telegram has no third-party OAuth | ✅ | Session health check; plaintext session storage; account-ban risk on aggressive use |
| **WhatsApp** | ✅ Cloud API token | ✅ Baileys QR pairing | ❌ Meta Graph OAuth not registered | ✅ | Cloud API + Baileys can't coexist per character; no TOS disclaimer |
| **iMessage / BlueBubbles** | 🚫 | ✅ macOS `chat.db` + BlueBubbles relay | 🚫 Apple offers no third-party OAuth | ⚠️ mac-only by definition | Document the "Windows operator + remote Mac BlueBubbles" setup |
| **Slack** | ✅ `xoxb-` bot token + cloud OAuth | ⚠️ `SLACK_USER_TOKEN` env recognized but cloud OAuth requests **bot scopes only**; `authed_user` from response not consumed | ⚠️ generic-routes, bot-only scopes | ✅ | Add user scopes (`chat:write:user`, `search:read`, `files:read`, `users:read`) and hydrate user token from OAuth response |
| **X / Twitter** | ✅ OAuth1.0a app + OAuth2 PKCE | ✅ OAuth2 PKCE end-to-end (`connectionRole: "agent"|"owner"` already on callback) | ✅ both flows wired | ✅ | Frontend never passes `connectionRole`; OAuth2 refresh hangs interactively in headless agents |
| **Google** (Gmail/Calendar/Drive/Chat) | ⚠️ user OAuth only (no service account) | ✅ OAuth2 + PKCE + `offline_access` + `prompt=consent` | ✅ 7 scopes wired in registry | ✅ | Two role representations coexist (legacy `agentGoogleSide` + new `connectionRole`); no scope-revocation detection |
| **Microsoft** (Outlook/Calendar) | ⚠️ delegated only (no client-credentials) | ✅ OAuth2 against `/consumers/` only | ⚠️ personal accounts only — work/school accounts excluded; no OneDrive/Teams scopes | ⚠️ personal only | Switch tenant to `/common/`; add `Files.ReadWrite.All` and Teams scopes |
| **GitHub** | ⚠️ PAT only (no GitHub App) | ✅ OAuth2 user-scope (role `OWNER` hardcoded) | ✅ user-scoped OAuth | ✅ | GitHub Apps (cleanest AGENT path) unimplemented; `refresh_token` captured but never rotated |
| **LinkedIn** | ❌ no plugin | ⚠️ cloud OAuth with `w_member_social` scope (approval status unknown) | ✅ cloud-only, no plugin | ⚠️ approval-gated | Add agent-side plugin; verify LinkedIn app review approval |
| **Instagram / Meta** | ⚠️ username/password (TOS-violating) | ❌ | ❌ Meta absent from provider registry | ⚠️ Business accounts only | Add Meta OAuth provider; declare personal Instagram out of scope |
| **Signal** | ⚠️ signal-cli only; `role` hardcoded `"OWNER"` | ⚠️ device-link to user's primary phone; loss of primary phone disconnects the agent | 🚫 Signal has no OAuth | ⚠️ tied to user's primary device | AGENT mode via separate bot phone number; auto-recover on daemon crash |
| **Matrix** | ✅ access token (any homeserver) | ✅ access token (same shape) | 🚫 per-homeserver, no central OAuth | ✅ | All accounts hardcoded `role: "OWNER"`; no password-login UI; full-sync only |
| **Email (IMAP/SMTP)** | ❌ no plugin | ❌ | n/a | ❌ | Plugin doesn't exist; cloud has outbound-only SMTP. Self-hosted / Fastmail / ProtonMail users unsupported |
| **Bluesky** | ✅ app password | ✅ app password (same shape) | 🚫 self-custodied | ✅ | `connector-account-provider.ts` hardcodes `role: "OWNER"` |
| **Farcaster** | ✅ Neynar signer | ✅ Neynar signer | 🚫 (Neynar API key gated) | ✅ | Hardcoded `role: "OWNER"`; centralized on Neynar |
| **Nostr** | ✅ nsec | ✅ nsec | 🚫 | ✅ | Hardcoded `role: "OWNER"` |
| **WeChat** | ✅ proxy API (third-party) | 🚫 personal WeChat TOS-forbidden | ❌ not in registry | 🚫 | Proxy supply-chain risk; document TOS posture |
| **Feishu / Lark** | ✅ app credentials | ❌ user delegation not wired | ❌ not in registry | ⚠️ | Add Feishu OAuth provider (user delegation exists) |
| **Line** | ✅ bot token | ❌ LINE Login imported but unused | ❌ not in registry | ⚠️ | Wire LINE Login OAuth — already in dependencies |
| **KakaoTalk** | ❌ no plugin | ❌ | ❌ | n/a | Add plugin if Asia-market deployments matter |
| **Linear** | ✅ API key + OAuth | ✅ OAuth (cloud-wired in plugin) | ✅ | ✅ | No `refresh_token` handling; no OWNER/AGENT split (hardcoded `"OWNER"`) |
| **Notion** | ❌ no plugin | ⚠️ cloud-only via OAuth | ✅ wired in registry | ✅ | No plugin; user info path workspace-scoped |
| **Asana** | ❌ no plugin | ⚠️ cloud-only OAuth | ✅ wired | ✅ | No plugin; no PAT path |
| **Jira** | ❌ no plugin | ⚠️ cloud-only OAuth (`auth.atlassian.com` hardcoded) | ✅ wired | ⚠️ cloud Atlassian only | No plugin; self-hosted Jira unsupported; no API-token path |
| **HubSpot / Salesforce / Airtable / Dropbox** | ❌ no plugins | ⚠️ cloud OAuth only | ✅ all four wired (Salesforce/Airtable use PKCE) | ✅ | No plugin code consuming these tokens |
| **Zoom** | ❌ no plugin | ❌ | ✅ in registry | ⚠️ | Plugin missing |
| **Calendly** | ✅ OAuth + PAT | ✅ OAuth (role hardcoded `"OWNER"`) | ✅ | ✅ | No refresh-token; no AGENT path |
| **Twilio** | ✅ Account SID + Auth Token (LifeOps-only) | ✅ same (subaccounts possible but unrouted) | n/a (api_key) | ✅ | No multi-account routing; no ConnectorAccountManager integration |
| **Shopify** | ✅ OAuth per-store | ✅ OAuth per-store | ❌ not in registry (plugin-owned OAuth) | ⚠️ | Hardcoded `role: "OWNER"`; no staff-account / AGENT delegation |
| **Duffel** | ✅ API key (LifeOps-only) | n/a | n/a | n/a | Single integration key; read-only |

---

## Cross-cutting findings

- **The data model already supports OWNER+AGENT.** Cloud OAuth tracks
  `connectionRole: "OWNER" | "AGENT" | "TEAM"` in `source_context` of the
  `platform_credentials` table. What's missing is **plugin manifest
  declarations of which sides are supported, UI partitioning of the two
  sections, and removal of hardcoded `role: "OWNER"` in
  `connector-account-provider.ts` across many plugins**.
- **17 providers in the cloud OAuth registry**: google, microsoft, linear,
  notion, github, slack, hubspot, asana, dropbox, salesforce, airtable, zoom,
  jira, linkedin, twitter, twilio, blooio. Discord has separate
  (bot-install-only) routes outside the generic registry.
- **Many connector-account-providers hardcode `role: "OWNER"`** — Bluesky,
  Farcaster, Nostr, Calendly, Shopify, Signal, Matrix, GitHub user, Linear,
  Telegram. These need role parameterization to respect the OWNER vs AGENT
  distinction the cloud has been carrying all along.
- **Single hardcoded `redirect_uri` per provider** in cloud OAuth. Multi-instance
  dev/prod cannot share the same OAuth client credentials — each instance
  needs its own.
- **Two role representations still coexist**: legacy
  `agentGoogleSide: "owner"|"agent"` (lowercase) and new
  `connectionRole: "OWNER"|"AGENT"|"TEAM"` (uppercase). A read-through
  normalizer exists; a write-through migration is outstanding.

## Schema entrypoint

The connector registry expresses OWNER+AGENT as the optional
`accounts: { owner?, agent? }` block on
[`connectorEntrySchema`](../../../packages/app-core/src/registry/schema.ts).
Each side declares its own `authKind`, `credentialKeys`, and optional
`osSupport` hints. When a manifest only declares the legacy `auth` field,
the loader auto-maps it to `accounts.agent` via `normalizeConnectorAuth()`,
so existing manifests keep working without edits.

## Out of scope here

- LifeOps grant store changes (the LifeOps repository already carries
  `side: "owner" | "agent"`).
- Per-instance `redirect_uri` support for multi-tenant OAuth deployments.
- Adding new cloud OAuth providers (Feishu, LINE Login, Meta, KakaoTalk).
- Adding plugin shells for cloud-only providers (Notion, Asana, Jira,
  HubSpot, Salesforce, Airtable, Dropbox, Zoom).
- iMessage on non-mac — platform-impossible.
