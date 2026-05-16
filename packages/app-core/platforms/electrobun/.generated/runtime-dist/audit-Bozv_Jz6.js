import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/cloud-jwks-store.js
const DEFAULT_JWKS_TTL_MS = 360 * 60 * 1e3;
/**
* Resolve the eliza state directory.
*
* Order: `ELIZA_STATE_DIR` → `ELIZA_STATE_DIR` → `~/.eliza`.
*/
function resolveElizaStateDir(env = process.env) {
	const explicit = env.ELIZA_STATE_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(os.homedir(), ".eliza");
}

//#endregion
//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/api/auth/audit.js
/**
* Auth audit emitter.
*
* Every sensitive auth action ends up in two places:
*   1. `auth_audit_events` table via `AuthStore.appendAuditEvent`.
*   2. JSONL file at `<state>/auth/audit.log`, rotated at 10MB, so the
*      operator can read history even if pglite is wiped.
*
* Both writes happen synchronously from the caller's perspective. If the DB
* write throws the file write still happens (and vice versa) — the operator
* notices a divergence rather than losing the event entirely.
*
* Token-shaped values (20+ characters of `[A-Za-z0-9_-]`) are redacted in
* `metadata` before either write, so a misconfigured caller can't smuggle a
* bearer token into an audit row.
*/
const AUDIT_LOG_FILENAME = "audit.log";
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const AUDIT_REDACTION_RE = /[A-Za-z0-9_-]{20,}/;
function truncateUserAgent(value) {
	if (!value) return null;
	return value.length > 200 ? value.slice(0, 200) : value;
}
/**
* Replace token-shaped runs in `metadata` with the literal `<redacted>` string.
*
* Only string values are scanned; numbers and booleans pass through unchanged.
*/
function redactMetadata(metadata) {
	const out = {};
	for (const [key, raw] of Object.entries(metadata)) {
		if (typeof raw !== "string") {
			out[key] = raw;
			continue;
		}
		out[key] = AUDIT_REDACTION_RE.test(raw) ? "<redacted>" : raw;
	}
	return out;
}
function resolveAuditLogPath(env = process.env) {
	return path.join(resolveElizaStateDir(env), "auth", AUDIT_LOG_FILENAME);
}
async function rotateIfNeeded(filePath) {
	let size;
	try {
		size = (await fs.stat(filePath)).size;
	} catch (err) {
		if (err.code === "ENOENT") return;
		throw err;
	}
	if (size < AUDIT_LOG_MAX_BYTES) return;
	const rotated = `${filePath}.1`;
	await fs.rename(filePath, rotated).catch(async (err) => {
		if (err.code !== "ENOENT") throw err;
	});
}
async function appendJsonLine(filePath, line) {
	await fs.mkdir(path.dirname(filePath), {
		recursive: true,
		mode: 448
	});
	await rotateIfNeeded(filePath);
	await fs.appendFile(filePath, `${JSON.stringify(line)}\n`, {
		encoding: "utf8",
		mode: 384
	});
}
/**
* Append an audit event to the database AND the JSONL log.
*
* Both writes are attempted. The first error is rethrown to the caller —
* an audit-write failure is a real problem and should surface, not be
* swallowed.
*/
async function appendAuditEvent(input, options) {
	const env = options.env ?? process.env;
	const now = options.now?.() ?? Date.now();
	const id = crypto.randomUUID();
	const safeMetadata = redactMetadata(input.metadata ?? {});
	const userAgent = truncateUserAgent(input.userAgent);
	const filePath = resolveAuditLogPath(env);
	const line = {
		id,
		ts: now,
		actorIdentityId: input.actorIdentityId,
		ip: input.ip,
		userAgent,
		action: input.action,
		outcome: input.outcome,
		metadata: safeMetadata
	};
	let firstError = null;
	const fileWrite = appendJsonLine(filePath, line).catch((err) => {
		if (firstError === null) firstError = err;
	});
	const dbWrite = options.store.appendAuditEvent({
		id,
		ts: now,
		actorIdentityId: input.actorIdentityId,
		ip: input.ip,
		userAgent,
		action: input.action,
		outcome: input.outcome,
		metadata: safeMetadata
	}).catch((err) => {
		if (firstError === null) firstError = err;
	});
	await Promise.all([fileWrite, dbWrite]);
	if (firstError !== null) throw firstError;
}

//#endregion
export { appendAuditEvent as t };