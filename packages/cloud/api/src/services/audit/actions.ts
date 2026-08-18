/**
 * Well-known audit action names. The dispatcher rejects events whose `action`
 * is not listed here, so adding a new action requires a code change (and a
 * matching entry in the metadata allowlist in `dispatcher.ts`).
 */
export const AUDIT_ACTIONS = [
  // auth
  "auth.login",
  // Emitted by the steward-session + logout routes since their inception but
  // never registered here, so the dispatcher rejected them and the failed-login
  // / logout trail only existed as an error log. Registered so the auth audit
  // trail actually records them.
  "auth.login.failed",
  "auth.logout",
  "auth.session.revoke",

  // OpenID Connect provider (Eliza Cloud issuing identity to relying parties)
  "oidc.authorize",
  "oidc.authorize.denied",
  "oidc.token",

  // api keys
  "api_key.revoke",
  "api_key.use",

  // secrets / vault
  "secret.access",

  // plugins
  "plugin.install",
  "plugin.uninstall",
  "plugin.grant",
  "plugin.revoke",
  "plugin.denied",

  // agents
  "agent.config.update",

  // vision / screen capture (opt-in capability)
  "vision.allowed",
  "vision.denied",

  // payments
  "payment.charge",
  "redemption.payout",

  // admin
  "admin.action",

  // data subject rights
  "data.export",
  "data.delete_request",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Browser-originated events are limited to user-visible security decisions.
 * Server-owned actions such as payments, administration, and key management
 * can only be emitted by their authoritative server-side operation.
 */
export const CLIENT_AUDIT_ACTIONS = [
  "plugin.install",
  "plugin.uninstall",
  "plugin.grant",
  "plugin.revoke",
  "plugin.denied",
  "vision.allowed",
  "vision.denied",
  "data.export",
  "data.delete_request",
  "auth.session.revoke",
  "api_key.revoke",
] as const satisfies readonly AuditAction[];

export type ClientAuditAction = (typeof CLIENT_AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(value: string): value is AuditAction {
  return ACTION_SET.has(value);
}
