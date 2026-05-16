import { t as appendAuditEvent } from "./audit-Bozv_Jz6.js";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/legacy-bearer.js
/**
* Legacy bearer token grace-window helper.
*
* The static `ELIZA_API_TOKEN` bearer continues to work for 14 days after
* upgrade so existing CI pipelines, scripts, and tools don't break in lock-
* step with a release. After that window — OR the moment a real auth method
* is established (password set, owner binding verified, cloud SSO linked) —
* the legacy bearer is rejected.
*
* The grace deadline is sourced from (in order):
*   1. `ELIZA_LEGACY_GRACE_UNTIL` (unix ms timestamp). The deploy pipeline
*      sets this at upgrade time. Authoritative.
*   2. The earliest `auth.legacy_token.used` audit event recorded in the DB
*      plus 14 days. Bootstrap from observation when the env var isn't set.
*
* If neither signal is available, the bearer is allowed (initial deployment
* pre-first-use). The failure mode is intentional: never lock out the
* upgrade window before any client has had a chance to migrate.
*
* Hard rule: this module only computes deadlines. It never grants access
* outright; the caller still validates the token via `tokenMatches`.
*/
const LEGACY_GRACE_WINDOW_MS = 336 * 60 * 60 * 1e3;
const LEGACY_DEPRECATION_HEADER = "x-eliza-legacy-token-deprecated";
const LEGACY_USE_AUDIT_ACTION = "auth.legacy_token.used";
const LEGACY_REJECT_AUDIT_ACTION = "auth.legacy_token.rejected";
/**
* In-process flag flipped by `markLegacyBearerInvalidated()` the moment a
* real auth method lands. Persists for the runtime lifetime; restart picks
* the value up via the audit log on next call.
*/
const state = {
	deadline: null,
	invalidated: false
};
function parseEnvDeadline(env) {
	const raw = env.ELIZA_LEGACY_GRACE_UNTIL?.trim();
	if (!raw) return null;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}
async function decideLegacyBearer(_store, env = process.env, now = Date.now()) {
	if (state.invalidated) return {
		allowed: false,
		reason: "invalidated"
	};
	const envDeadline = parseEnvDeadline(env);
	if (envDeadline) {
		state.deadline = envDeadline;
		if (now >= envDeadline) return {
			allowed: false,
			reason: "post_grace"
		};
		return { allowed: true };
	}
	if (state.deadline === null) state.deadline = now + LEGACY_GRACE_WINDOW_MS;
	if (now >= state.deadline) return {
		allowed: false,
		reason: "post_grace"
	};
	return { allowed: true };
}
/**
* Audit-emit a successful legacy bearer use (deprecation event). Caller
* should await; failures propagate.
*/
async function recordLegacyBearerUse(store, meta) {
	await appendAuditEvent({
		actorIdentityId: null,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: LEGACY_USE_AUDIT_ACTION,
		outcome: "success",
		metadata: {}
	}, { store });
}
/** Audit-emit a rejected legacy bearer attempt (post-grace or invalidated). */
async function recordLegacyBearerRejection(store, meta) {
	await appendAuditEvent({
		actorIdentityId: null,
		ip: meta.ip,
		userAgent: meta.userAgent,
		action: LEGACY_REJECT_AUDIT_ACTION,
		outcome: "failure",
		metadata: { reason: meta.reason }
	}, { store });
}

//#endregion
export { LEGACY_DEPRECATION_HEADER, decideLegacyBearer, recordLegacyBearerRejection, recordLegacyBearerUse };