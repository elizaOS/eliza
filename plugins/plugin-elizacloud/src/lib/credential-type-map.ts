/**
 * Mapping from workflow-plugin credential type names to Eliza Cloud connector
 * OAuth and agent-binding requests.
 *
 * The workflow plugin's LLM emits credential type strings (e.g. `gmailOAuth2`,
 * `slackOAuth2Api`) on each node that needs an external account. The cloud
 * exposes generic OAuth initiation and agent-scoped connector bindings.
 *
 * This map is the single source of truth for which workflow credential type
 * resolves through which cloud connector + with which OAuth scopes. Add new
 * entries when the cloud gains support for additional connectors; do not
 * scatter cred-type → connector logic elsewhere.
 *
 * Cloud-side endpoint convention:
 *   POST /api/v1/oauth/<connector>/initiate
 *   GET  /api/v1/eliza/agents/<agentId>/connectors
 *
 * Not every connector below has a fully-implemented cloud endpoint yet — the
 * provider returns `null` for unmapped types and `needs_auth` (with the
 * cloud-issued OAuth URL) for mapped-but-not-connected accounts. See
 * `cloud-credential-provider.ts` for the resolution logic.
 */

import {
  GOOGLE_WORKSPACE_MCP_RESOURCES,
  type GoogleWorkspaceMcpResourceProduct,
} from "@elizaos/shared/contracts";

const GOOGLE_IDENTITY_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

function googleScopes(products: readonly GoogleWorkspaceMcpResourceProduct[]): string[] {
  return [
    ...new Set([
      ...GOOGLE_IDENTITY_SCOPES,
      ...products.flatMap((product) => [...GOOGLE_WORKSPACE_MCP_RESOURCES[product].acceptedScopes]),
    ]),
  ];
}

export interface CredentialTypeMapping {
  /**
   * Cloud provider slug used by generic OAuth and binding status lookup.
   */
  connector: string;
  /**
   * MCP products atomically bound to the agent after OAuth callback.
   */
  products?: GoogleWorkspaceMcpResourceProduct[];
  /** Minimal OAuth scopes requested for the selected products. */
  scopes?: string[];
  /**
   * Friendly description used in `needs_auth` UI prompts. The runtime may
   * surface this verbatim to the end-user.
   */
  friendlyName: string;
}

/**
 * Workflow credential type → cloud connector mapping.
 *
 * Names mirror the n8n / workflows-plugin convention used by the LLM in
 * `plugins/plugin-workflow/src/utils/workflow-prompts/workflowGeneration.ts`.
 * Both `gmailOAuth2` and `gmailOAuth2Api` map to the same connector — the
 * workflow resolver does fuzzy `Api`-suffix matching upstream, but we keep
 * both keys here so `checkCredentialTypes` answers truthfully without the
 * caller having to know about that fuzziness.
 */
export const credTypeToConnector: ReadonlyMap<string, CredentialTypeMapping> = new Map([
  // ─── Google ──────────────────────────────────────────────────────────
  // Google uses the generic OAuth flow and binds its official MCP products to
  // this runtime's canonical agent ID in the callback transaction.
  [
    "gmailOAuth2",
    {
      connector: "google",
      products: ["gmail"],
      scopes: googleScopes(["gmail"]),
      friendlyName: "Gmail",
    },
  ],
  [
    "gmailOAuth2Api",
    {
      connector: "google",
      products: ["gmail"],
      scopes: googleScopes(["gmail"]),
      friendlyName: "Gmail",
    },
  ],
  [
    "googleCalendarOAuth2Api",
    {
      connector: "google",
      products: ["calendar"],
      scopes: googleScopes(["calendar"]),
      friendlyName: "Google Calendar",
    },
  ],
  [
    "googleSheetsOAuth2Api",
    {
      connector: "google",
      products: ["sheets"],
      scopes: googleScopes(["sheets"]),
      friendlyName: "Google Sheets",
    },
  ],

  // ─── GitHub ──────────────────────────────────────────────────────────
  // Cloud endpoint: /api/v1/eliza/github-oauth-complete/ (callback only).
  // The initiate flow is host-driven; the provider returns `needs_auth`
  // pointing at the cloud's GitHub install URL when not connected.
  [
    "githubOAuth2Api",
    {
      connector: "github",
      friendlyName: "GitHub",
    },
  ],
  [
    "githubApi",
    {
      connector: "github",
      friendlyName: "GitHub",
    },
  ],

  // ─── Discord ─────────────────────────────────────────────────────────
  // Cloud endpoint: /api/v1/eliza/discord/gateway-agent/ (gateway pairing).
  // No OAuth-token-issuance flow yet — provider returns `null` so the
  // workflow resolver falls back to its default missing-connection report.
  [
    "discordApi",
    {
      connector: "discord",
      friendlyName: "Discord",
    },
  ],
  [
    "discordBotApi",
    {
      connector: "discord",
      friendlyName: "Discord (Bot)",
    },
  ],
]);

/** Set used by `checkCredentialTypes` for O(1) supported-set membership. */
export const supportedCredTypes: ReadonlySet<string> = new Set(credTypeToConnector.keys());
