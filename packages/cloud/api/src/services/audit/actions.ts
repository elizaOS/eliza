/**
 * Well-known audit action names. The dispatcher rejects events whose `action`
 * is not listed here, so adding a new action requires a code change (and a
 * matching entry in the metadata allowlist in `dispatcher.ts`).
 */
export const AUDIT_ACTIONS = [
  // auth
  "auth.login",
  "auth.logout",
  "auth.login.failed",
  "auth.mfa.enroll",
  "auth.mfa.challenge",
  "auth.mfa.verify",
  "auth.password.change",
  "auth.password.reset",
  "auth.session.revoke",

  // api keys
  "api_key.create",
  "api_key.revoke",
  "api_key.use",
  "api_key.rotate",

  // secrets / vault
  "secret.access",
  "secret.create",
  "secret.update",
  "secret.delete",

  // plugins
  "plugin.install",
  "plugin.uninstall",
  "plugin.grant",
  "plugin.revoke",
  "plugin.execute",
  "plugin.denied",

  // agents
  "agent.spawn",
  "agent.terminate",
  "agent.config.update",
  "agent.session_record",

  // vision / screen capture (opt-in capability)
  "vision.allowed",
  "vision.denied",

  // payments
  "payment.charge",
  "payment.refund",
  "redemption.payout",
  "redemption.request",

  // admin
  "admin.action",
  "admin.user.impersonate",
  "admin.policy.update",

  // data subject rights
  "data.export",
  "data.delete_request",
  "data.delete_complete",

  // kms
  "kms.key.create",
  "kms.key.rotate",
  "kms.key.access",
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
