import { and, desc, eq, isNull, lte, ne } from "@elizaos/plugin-sql/drizzle";
import { authAuditEventTable, authBootstrapJtiSeenTable, authIdentityTable, authOwnerBindingTable, authOwnerLoginTokenTable, authSessionTable } from "@elizaos/plugin-sql/schema";

//#region node_modules/.bun/@elizaos+app-core@2.0.0-alpha.537+72829346cb4c43b1/node_modules/@elizaos/app-core/packages/app-core/src/services/auth-store.js
/**
* pglite-backed repositories for the auth subsystem.
*
* The store operates on a Drizzle database handle obtained from the agent
* runtime's database adapter (`@elizaos/plugin-sql`). Tables are owned by the
* plugin-sql schema attached to the root plugin export.
*
* Every method is fail-fast: errors propagate to the caller. The auth code
* path must NEVER swallow a DB error and pretend a request was authenticated.
*/
function nullableString(value) {
	return value === void 0 ? null : value;
}
function rowToIdentity(row) {
	return {
		id: row.id,
		kind: row.kind === "machine" ? "machine" : "owner",
		displayName: row.displayName,
		createdAt: Number(row.createdAt),
		passwordHash: row.passwordHash ?? null,
		cloudUserId: row.cloudUserId ?? null
	};
}
function rowToSession(row) {
	return {
		id: row.id,
		identityId: row.identityId,
		kind: row.kind === "machine" ? "machine" : "browser",
		createdAt: Number(row.createdAt),
		lastSeenAt: Number(row.lastSeenAt),
		expiresAt: Number(row.expiresAt),
		rememberDevice: row.rememberDevice,
		csrfSecret: row.csrfSecret,
		ip: row.ip ?? null,
		userAgent: row.userAgent ?? null,
		scopes: Array.isArray(row.scopes) ? row.scopes : [],
		revokedAt: row.revokedAt === null || row.revokedAt === void 0 ? null : Number(row.revokedAt)
	};
}
var AuthStore = class {
	db;
	constructor(db) {
		this.db = db;
	}
	async createIdentity(input) {
		const row = (await this.db.insert(authIdentityTable).values({
			id: input.id,
			kind: input.kind,
			displayName: input.displayName,
			createdAt: input.createdAt,
			passwordHash: nullableString(input.passwordHash),
			cloudUserId: nullableString(input.cloudUserId)
		}).returning())[0];
		if (!row) throw new Error("auth-store: createIdentity returned no row");
		return rowToIdentity(row);
	}
	async findIdentity(id) {
		const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.id, id)).limit(1))[0];
		return row ? rowToIdentity(row) : null;
	}
	async findIdentityByCloudUserId(cloudUserId) {
		const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.cloudUserId, cloudUserId)).limit(1))[0];
		return row ? rowToIdentity(row) : null;
	}
	async findIdentityByDisplayName(displayName) {
		const row = (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.displayName, displayName)).limit(1))[0];
		return row ? rowToIdentity(row) : null;
	}
	async updateIdentityPassword(id, passwordHash) {
		await this.db.update(authIdentityTable).set({ passwordHash }).where(eq(authIdentityTable.id, id));
	}
	async listIdentitiesByKind(kind) {
		return (await this.db.select().from(authIdentityTable).where(eq(authIdentityTable.kind, kind))).map(rowToIdentity);
	}
	async hasOwnerIdentity() {
		return (await this.db.select({ id: authIdentityTable.id }).from(authIdentityTable).where(eq(authIdentityTable.kind, "owner")).limit(1)).length > 0;
	}
	async createSession(input) {
		const row = (await this.db.insert(authSessionTable).values({
			id: input.id,
			identityId: input.identityId,
			kind: input.kind,
			createdAt: input.createdAt,
			lastSeenAt: input.lastSeenAt,
			expiresAt: input.expiresAt,
			rememberDevice: input.rememberDevice,
			csrfSecret: input.csrfSecret,
			ip: nullableString(input.ip),
			userAgent: nullableString(input.userAgent),
			scopes: input.scopes
		}).returning())[0];
		if (!row) throw new Error("auth-store: createSession returned no row");
		return rowToSession(row);
	}
	/**
	* Look up a session by id. Returns `null` for unknown id, expired session,
	* or revoked session — the caller MUST treat `null` as "not authenticated"
	* and never as "transient error".
	*/
	async findSession(id, now = Date.now()) {
		const row = (await this.db.select().from(authSessionTable).where(eq(authSessionTable.id, id)).limit(1))[0];
		if (!row) return null;
		const session = rowToSession(row);
		if (session.revokedAt !== null) return null;
		if (session.expiresAt <= now) return null;
		return session;
	}
	async revokeSession(id, now = Date.now()) {
		const result = await this.db.update(authSessionTable).set({ revokedAt: now }).where(and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)));
		return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
	}
	/**
	* Slide the browser session forward: bump `lastSeenAt` and extend
	* `expiresAt`. Caller computes the new `expiresAt` so the store stays
	* policy-free.
	*/
	async touchSession(id, lastSeenAt, expiresAt) {
		await this.db.update(authSessionTable).set({
			lastSeenAt,
			expiresAt
		}).where(and(eq(authSessionTable.id, id), isNull(authSessionTable.revokedAt)));
	}
	/**
	* Revoke every active session for an identity, except optionally the one
	* currently in use. Returns the number of rows updated. Implemented in a
	* single statement — no read/write race window.
	*/
	async revokeAllSessionsForIdentity(identityId, now = Date.now(), exceptSessionId) {
		const condition = exceptSessionId ? and(eq(authSessionTable.identityId, identityId), isNull(authSessionTable.revokedAt), ne(authSessionTable.id, exceptSessionId)) : and(eq(authSessionTable.identityId, identityId), isNull(authSessionTable.revokedAt));
		const result = await this.db.update(authSessionTable).set({ revokedAt: now }).where(condition);
		return typeof result.rowCount === "number" ? result.rowCount : 0;
	}
	/**
	* Mark every active legacy machine session (scopes containing the literal
	* "legacy" entry) as revoked. Used when a real auth method lands and the
	* legacy bearer must be retired immediately.
	*/
	async revokeLegacyBearerSessions(now = Date.now()) {
		const allMachine = await this.db.select().from(authSessionTable).where(and(eq(authSessionTable.kind, "machine"), isNull(authSessionTable.revokedAt)));
		let revoked = 0;
		for (const row of allMachine) {
			const session = rowToSession(row);
			if (!session.scopes.includes("legacy")) continue;
			await this.db.update(authSessionTable).set({ revokedAt: now }).where(eq(authSessionTable.id, session.id));
			revoked += 1;
		}
		return revoked;
	}
	/**
	* List every active (unrevoked, unexpired) session for an identity, newest
	* first. Used by `/api/auth/sessions` to populate the security UI.
	*/
	async listSessionsForIdentity(identityId, now = Date.now()) {
		const rows = await this.db.select().from(authSessionTable).where(eq(authSessionTable.identityId, identityId)).orderBy(desc(authSessionTable.lastSeenAt));
		const out = [];
		for (const row of rows) {
			const session = rowToSession(row);
			if (session.revokedAt !== null) continue;
			if (session.expiresAt <= now) continue;
			out.push(session);
		}
		return out;
	}
	/**
	* Atomic test-and-set on the bootstrap-token replay set.
	*
	* Returns `true` when this `jti` was unseen and is now recorded.
	* Returns `false` when the `jti` was already present — indicating a replay.
	*
	* Implemented via INSERT … ON CONFLICT DO NOTHING so the check is one
	* round trip and there is no TOCTOU window.
	*/
	async recordJtiSeen(jti, now = Date.now()) {
		return (await this.db.insert(authBootstrapJtiSeenTable).values({
			jti,
			seenAt: now
		}).onConflictDoNothing({ target: authBootstrapJtiSeenTable.jti }).returning()).length > 0;
	}
	async pruneJtiSeenBefore(thresholdTs) {
		await this.db.delete(authBootstrapJtiSeenTable).where(lte(authBootstrapJtiSeenTable.seenAt, thresholdTs));
	}
	async appendAuditEvent(input) {
		const row = (await this.db.insert(authAuditEventTable).values({
			id: input.id,
			ts: input.ts,
			actorIdentityId: nullableString(input.actorIdentityId),
			ip: nullableString(input.ip),
			userAgent: nullableString(input.userAgent),
			action: input.action,
			outcome: input.outcome,
			metadata: input.metadata
		}).returning())[0];
		if (!row) throw new Error("auth-store: appendAuditEvent returned no row");
		return {
			id: row.id,
			ts: Number(row.ts),
			actorIdentityId: row.actorIdentityId ?? null,
			ip: row.ip ?? null,
			userAgent: row.userAgent ?? null,
			action: row.action,
			outcome: row.outcome === "failure" ? "failure" : "success",
			metadata: row.metadata ?? {}
		};
	}
	async createOwnerBinding(input) {
		await this.db.insert(authOwnerBindingTable).values({
			id: input.id,
			identityId: input.identityId,
			connector: input.connector,
			externalId: input.externalId,
			displayHandle: input.displayHandle,
			instanceId: input.instanceId,
			verifiedAt: input.verifiedAt,
			pendingCodeHash: nullableString(input.pendingCodeHash),
			pendingExpiresAt: input.pendingExpiresAt === null || input.pendingExpiresAt === void 0 ? null : input.pendingExpiresAt
		});
	}
	async findOwnerBinding(id) {
		const row = (await this.db.select().from(authOwnerBindingTable).where(eq(authOwnerBindingTable.id, id)).limit(1))[0];
		return row ? rowToOwnerBinding(row) : null;
	}
	async findOwnerBindingByPendingCodeHash(pendingCodeHash, instanceId) {
		const row = (await this.db.select().from(authOwnerBindingTable).where(and(eq(authOwnerBindingTable.pendingCodeHash, pendingCodeHash), eq(authOwnerBindingTable.instanceId, instanceId))).limit(1))[0];
		return row ? rowToOwnerBinding(row) : null;
	}
	async findOwnerBindingByConnectorPair(input) {
		const row = (await this.db.select().from(authOwnerBindingTable).where(and(eq(authOwnerBindingTable.connector, input.connector), eq(authOwnerBindingTable.externalId, input.externalId), eq(authOwnerBindingTable.instanceId, input.instanceId))).limit(1))[0];
		return row ? rowToOwnerBinding(row) : null;
	}
	async listOwnerBindingsForIdentity(identityId) {
		return (await this.db.select().from(authOwnerBindingTable).where(eq(authOwnerBindingTable.identityId, identityId)).orderBy(desc(authOwnerBindingTable.verifiedAt))).map(rowToOwnerBinding);
	}
	async updateOwnerBindingPending(id, pendingCodeHash, pendingExpiresAt) {
		await this.db.update(authOwnerBindingTable).set({
			pendingCodeHash,
			pendingExpiresAt
		}).where(eq(authOwnerBindingTable.id, id));
	}
	async markOwnerBindingVerified(id, verifiedAt, displayHandle) {
		await this.db.update(authOwnerBindingTable).set({
			verifiedAt,
			displayHandle,
			pendingCodeHash: null,
			pendingExpiresAt: null
		}).where(eq(authOwnerBindingTable.id, id));
	}
	async deleteOwnerBinding(id) {
		const result = await this.db.delete(authOwnerBindingTable).where(eq(authOwnerBindingTable.id, id));
		return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
	}
	async createOwnerLoginToken(input) {
		await this.db.insert(authOwnerLoginTokenTable).values({
			tokenHash: input.tokenHash,
			identityId: input.identityId,
			bindingId: input.bindingId,
			issuedAt: input.issuedAt,
			expiresAt: input.expiresAt
		});
	}
	async findOwnerLoginToken(tokenHash) {
		const row = (await this.db.select().from(authOwnerLoginTokenTable).where(eq(authOwnerLoginTokenTable.tokenHash, tokenHash)).limit(1))[0];
		return row ? rowToOwnerLoginToken(row) : null;
	}
	/**
	* Atomically mark the token as consumed. Returns true when the consume
	* succeeded (token existed, was unconsumed, was unexpired). Returns
	* false otherwise — the caller MUST treat false as "auth failure" and
	* never as "transient error".
	*/
	async consumeOwnerLoginToken(tokenHash, now) {
		const result = await this.db.update(authOwnerLoginTokenTable).set({ consumedAt: now }).where(and(eq(authOwnerLoginTokenTable.tokenHash, tokenHash), isNull(authOwnerLoginTokenTable.consumedAt)));
		return typeof result.rowCount === "number" ? result.rowCount > 0 : true;
	}
};
function rowToOwnerBinding(row) {
	return {
		id: row.id,
		identityId: row.identityId,
		connector: row.connector,
		externalId: row.externalId,
		displayHandle: row.displayHandle,
		instanceId: row.instanceId,
		verifiedAt: Number(row.verifiedAt),
		pendingCodeHash: row.pendingCodeHash ?? null,
		pendingExpiresAt: row.pendingExpiresAt === null || row.pendingExpiresAt === void 0 ? null : Number(row.pendingExpiresAt)
	};
}
function rowToOwnerLoginToken(row) {
	return {
		tokenHash: row.tokenHash,
		identityId: row.identityId,
		bindingId: row.bindingId,
		issuedAt: Number(row.issuedAt),
		expiresAt: Number(row.expiresAt),
		consumedAt: row.consumedAt === null || row.consumedAt === void 0 ? null : Number(row.consumedAt)
	};
}

//#endregion
export { AuthStore };