/**
 * Well-known audit action names. The dispatcher rejects events whose `action`
 * is not listed here, so adding a new action requires a code change (and a
 * matching entry in the metadata allowlist in `dispatcher.ts`).
 */
export declare const AUDIT_ACTIONS: readonly ["auth.login", "auth.logout", "auth.login.failed", "auth.mfa.enroll", "auth.mfa.challenge", "auth.mfa.verify", "auth.password.change", "auth.password.reset", "auth.session.revoke", "api_key.create", "api_key.revoke", "api_key.use", "api_key.rotate", "secret.access", "secret.create", "secret.update", "secret.delete", "plugin.install", "plugin.uninstall", "plugin.grant", "plugin.revoke", "plugin.execute", "plugin.denied", "agent.spawn", "agent.terminate", "agent.config.update", "agent.session_record", "vision.allowed", "vision.denied", "payment.charge", "payment.refund", "redemption.payout", "redemption.request", "admin.action", "admin.user.impersonate", "admin.policy.update", "data.export", "data.delete_request", "data.delete_complete", "kms.key.create", "kms.key.rotate", "kms.key.access"];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export declare function isAuditAction(value: string): value is AuditAction;
//# sourceMappingURL=actions.d.ts.map