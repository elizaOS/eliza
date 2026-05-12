/**
 * Mapping from workflow-plugin credential type names → Eliza Cloud connector slugs.
 *
 * The workflow plugin's LLM emits credential type strings (e.g. `gmailOAuth2`,
 * `slackOAuth2Api`) on each node that needs an external account. The cloud
 * exposes per-connector OAuth flows under `/api/v1/eliza/<connector>/...`.
 *
 * This map is the single source of truth for which workflow credential type
 * resolves through which cloud connector + with which OAuth scopes. Add new
 * entries when the cloud gains support for additional connectors; do not
 * scatter cred-type → connector logic elsewhere.
 *
 * Cloud-side endpoint convention (see cloud/apps/api/v1/eliza/<connector>/):
 *   POST /api/v1/eliza/<connector>/connect/initiate     → { authUrl }
 *   GET  /api/v1/eliza/<connector>/status               → { connected, ... }
 *
 * Not every connector below has a fully-implemented cloud endpoint yet — the
 * provider returns `null` for unmapped types and `needs_auth` (with the
 * cloud-issued OAuth URL) for mapped-but-not-connected accounts. See
 * `cloud-credential-provider.ts` for the resolution logic.
 */

export interface CredentialTypeMapping {
  /**
   * Cloud connector slug used in the URL path
   * (`/api/v1/eliza/<connector>/connect/initiate`).
   */
  connector: string;
  /**
   * Optional capability tokens passed to the cloud's `connect/initiate`
   * endpoint. The cloud translates these to provider-specific OAuth scopes
   * (e.g. Google's `google.gmail.send` → `https://www.googleapis.com/auth/gmail.send`).
   */
  capabilities?: string[];
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
  // Cloud endpoint: /api/v1/eliza/google/{connect/initiate,status,disconnect}
  // The cloud's capability tokens are documented in
  // cloud/apps/api/v1/eliza/google/connect/initiate/route.ts.
  [
    "gmailOAuth2",
    {
      connector: "google",
      capabilities: ["google.gmail.triage", "google.gmail.send", "google.gmail.manage"],
      friendlyName: "Gmail",
    },
  ],
  [
    "gmailOAuth2Api",
    {
      connector: "google",
      capabilities: ["google.gmail.triage", "google.gmail.send", "google.gmail.manage"],
      friendlyName: "Gmail",
    },
  ],
  [
    "googleCalendarOAuth2Api",
    {
      connector: "google",
      capabilities: ["google.calendar.read", "google.calendar.write"],
      friendlyName: "Google Calendar",
    },
  ],
  [
    "googleSheetsOAuth2Api",
    {
      connector: "google",
      capabilities: ["google.basic_identity"],
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
