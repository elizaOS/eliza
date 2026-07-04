/**
 * Exercises the read-side access-control filter — `actorFromAccessContext`,
 * `canReadScope`, and `filterByAccessContext` — as pure deterministic
 * functions, plus a verbatim cross-check against the documents read ladder.
 */
import { describe, expect, it } from "vitest";
import type { AccessContext, Memory, MemoryScope, UUID } from "../types";
import {
	type ActorRole,
	actorFromAccessContext,
	canReadScope,
	filterByAccessContext,
	type ScopeActor,
} from "./filter";

const SELF = "00000000-0000-0000-0000-00000000005e" as UUID;
const OTHER = "00000000-0000-0000-0000-0000000000af" as UUID;
const AGENT = "00000000-0000-0000-0000-0000000000a9" as UUID;

const actor = (role: ActorRole, entityId: UUID = SELF): ScopeActor => ({
	entityId,
	role,
});

describe("actorFromAccessContext", () => {
	const ctx = (over: Partial<AccessContext>): AccessContext => ({
		requesterEntityId: SELF,
		...over,
	});

	it("maps a self-read (requester is the agent) to AGENT", () => {
		expect(
			actorFromAccessContext(ctx({ requesterEntityId: AGENT }), AGENT),
		).toEqual({ entityId: AGENT, role: "AGENT" });
	});

	it("maps OWNER, ADMIN, and isOwner to the OWNER tier", () => {
		expect(actorFromAccessContext(ctx({ role: "OWNER" }), AGENT).role).toBe(
			"OWNER",
		);
		expect(actorFromAccessContext(ctx({ role: "ADMIN" }), AGENT).role).toBe(
			"OWNER",
		);
		expect(actorFromAccessContext(ctx({ isOwner: true }), AGENT).role).toBe(
			"OWNER",
		);
	});

	it("maps USER, GUEST, and an unresolved role to the least-privileged USER tier", () => {
		expect(actorFromAccessContext(ctx({ role: "USER" }), AGENT).role).toBe(
			"USER",
		);
		expect(actorFromAccessContext(ctx({ role: "GUEST" }), AGENT).role).toBe(
			"USER",
		);
		expect(actorFromAccessContext(ctx({}), AGENT).role).toBe("USER"); // no world resolved → fails closed
	});
});

describe("canReadScope", () => {
	it("lets everyone read global / shared / room", () => {
		const open: MemoryScope[] = ["global", "shared", "room"];
		const roles: ActorRole[] = [
			"OWNER",
			"ADMIN",
			"USER",
			"GUEST",
			"AGENT",
			"RUNTIME",
		];
		for (const scope of open) {
			for (const role of roles) {
				expect(canReadScope(scope, undefined, actor(role))).toBe(true);
			}
		}
	});

	it("gates owner-private to OWNER and RUNTIME only", () => {
		expect(canReadScope("owner-private", undefined, actor("OWNER"))).toBe(true);
		expect(canReadScope("owner-private", undefined, actor("RUNTIME"))).toBe(
			true,
		);
		for (const role of ["USER", "GUEST", "ADMIN", "AGENT"] as ActorRole[]) {
			expect(canReadScope("owner-private", undefined, actor(role))).toBe(false);
		}
	});

	it("gates agent-private to OWNER, AGENT, and RUNTIME", () => {
		for (const role of ["OWNER", "AGENT", "RUNTIME"] as ActorRole[]) {
			expect(canReadScope("agent-private", undefined, actor(role))).toBe(true);
		}
		for (const role of ["USER", "GUEST", "ADMIN"] as ActorRole[]) {
			expect(canReadScope("agent-private", undefined, actor(role))).toBe(false);
		}
	});

	describe("user-private / private — entity-scoped ladder", () => {
		for (const scope of ["user-private", "private"] as MemoryScope[]) {
			it(`${scope}: a USER reads only their own`, () => {
				expect(canReadScope(scope, SELF, actor("USER", SELF))).toBe(true);
				expect(canReadScope(scope, OTHER, actor("USER", SELF))).toBe(false);
			});

			it(`${scope}: AGENT and RUNTIME read any`, () => {
				expect(canReadScope(scope, OTHER, actor("AGENT", AGENT))).toBe(true);
				expect(canReadScope(scope, OTHER, actor("RUNTIME", AGENT))).toBe(true);
			});

			it(`${scope}: an OWNER reads their own, or another's only via scopedToEntityId`, () => {
				expect(canReadScope(scope, SELF, actor("OWNER", SELF))).toBe(true);
				expect(canReadScope(scope, OTHER, actor("OWNER", SELF))).toBe(false);
				expect(
					canReadScope(scope, OTHER, actor("OWNER", SELF), {
						scopedToEntityId: OTHER,
					}),
				).toBe(true);
			});

			it(`${scope}: a memory with no owning entity is unreadable by anyone (fail closed)`, () => {
				// Mirrors canReadDocumentMemory: the `!scopedEntityId` guard returns
				// false BEFORE the AGENT/RUNTIME bypass, so even a machine read fails.
				for (const role of [
					"USER",
					"OWNER",
					"AGENT",
					"RUNTIME",
				] as ActorRole[]) {
					expect(canReadScope(scope, undefined, actor(role, AGENT))).toBe(
						false,
					);
				}
			});
		}
	});

	// Regression guard: for the four DOCUMENT scopes, canReadScope must be
	// byte-identical to the documents plugin's canReadDocumentMemory ladder
	// (plugins/plugin-documents/src/routes.ts:408-430), so documents can delegate
	// here without behavior change.
	it("matches the documents read ladder verbatim for document scopes", () => {
		const docLadder = (
			scope: MemoryScope,
			scopedEntityId: UUID | undefined,
			a: ScopeActor,
			scopedToEntityId?: UUID,
		): boolean => {
			if (scope === "global") return true;
			if (scope === "owner-private")
				return a.role === "OWNER" || a.role === "RUNTIME";
			if (scope === "agent-private")
				return a.role === "OWNER" || a.role === "AGENT" || a.role === "RUNTIME";
			if (!scopedEntityId) return false;
			if (a.role === "AGENT" || a.role === "RUNTIME") return true;
			if (a.role === "OWNER")
				return scopedToEntityId
					? scopedEntityId === scopedToEntityId
					: scopedEntityId === a.entityId;
			return scopedEntityId === a.entityId;
		};

		const docScopes: MemoryScope[] = [
			"global",
			"owner-private",
			"agent-private",
			"user-private",
		];
		const roles: ActorRole[] = ["OWNER", "USER", "AGENT", "RUNTIME"];
		const owners: (UUID | undefined)[] = [SELF, OTHER, undefined];
		const filters: (UUID | undefined)[] = [undefined, OTHER];

		for (const scope of docScopes) {
			for (const role of roles) {
				for (const owner of owners) {
					for (const filter of filters) {
						const a = actor(role, SELF);
						const opts = filter ? { scopedToEntityId: filter } : undefined;
						expect(canReadScope(scope, owner, a, opts)).toBe(
							docLadder(scope, owner, a, filter),
						);
					}
				}
			}
		}
	});
});

describe("filterByAccessContext", () => {
	const mem = (scope: MemoryScope, owner: UUID): Memory =>
		({
			entityId: owner,
			roomId: SELF,
			content: { text: "m" },
			metadata: { type: "custom", scope },
		}) as Memory;

	const corpus: Memory[] = [
		mem("global", OTHER),
		mem("owner-private", OTHER),
		mem("agent-private", OTHER),
		mem("user-private", SELF),
		mem("user-private", OTHER),
	];

	const scopesOf = (memories: Memory[]) =>
		memories.map((m) => m.metadata?.scope);

	it("a USER keeps global + their own user-private only", () => {
		const ctx: AccessContext = { requesterEntityId: SELF, role: "USER" };
		const visible = filterByAccessContext(corpus, ctx, AGENT);
		// global (any owner) + user-private owned by SELF; owner/agent-private and
		// OTHER's user-private are dropped.
		expect(visible).toHaveLength(2);
		expect(scopesOf(visible)).toEqual(["global", "user-private"]);
		expect(visible[1]?.entityId).toBe(SELF);
	});

	it("the agent (self-read) keeps everything except owner-private", () => {
		// owner-private is OWNER/RUNTIME only — an AGENT-role read does not see it,
		// mirroring the documents ladder. (Background agent reads are unfiltered in
		// practice: they pass no accessContext at all.)
		const ctx: AccessContext = { requesterEntityId: AGENT };
		expect(scopesOf(filterByAccessContext(corpus, ctx, AGENT))).toEqual([
			"global",
			"agent-private",
			"user-private",
			"user-private",
		]);
	});

	it("an OWNER keeps global, owner-private, agent-private, and their own user-private", () => {
		const ctx: AccessContext = {
			requesterEntityId: SELF,
			role: "OWNER",
			isOwner: true,
		};
		const visible = filterByAccessContext(corpus, ctx, AGENT);
		expect(scopesOf(visible)).toEqual([
			"global",
			"owner-private",
			"agent-private",
			"user-private",
		]);
		expect(visible[3]?.entityId).toBe(SELF);
	});

	it("is idempotent — filtering twice equals filtering once", () => {
		const ctx: AccessContext = { requesterEntityId: SELF, role: "USER" };
		const once = filterByAccessContext(corpus, ctx, AGENT);
		const twice = filterByAccessContext(once, ctx, AGENT);
		expect(twice).toEqual(once);
	});

	it("defaults a memory with no scope to global (readable)", () => {
		const noScope = {
			entityId: OTHER,
			roomId: SELF,
			content: { text: "m" },
		} as Memory;
		const ctx: AccessContext = { requesterEntityId: SELF, role: "USER" };
		expect(filterByAccessContext([noScope], ctx, AGENT)).toHaveLength(1);
	});
});
