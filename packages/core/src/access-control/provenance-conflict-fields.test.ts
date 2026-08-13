/**
 * Provenance conflict-field rejection tests: proves that conflicting
 * accountId, platformMessageId, and scope values across metadata paths are
 * rejected (invalid_provenance) instead of silently selecting the first one.
 *
 * Deterministic unit tests against {@link deriveCanonicalProvenance} — no
 * runtime, no database, no mocks. Each case constructs a minimal {@link Memory}
 * with the conflicting fields and asserts the result is invalid.
 */
import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { deriveCanonicalProvenance } from "./provenance-envelope";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;

/** Minimal valid memory — callers override specific fields to test conflicts. */
function makeMemory(
	metadataOverrides: Record<string, unknown>,
	contentOverrides: Record<string, unknown> = {},
): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010" as UUID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		worldId: undefined,
		createdAt: Date.now(),
		content: { source: "discord", ...contentOverrides },
		metadata: {
			provider: "discord",
			accountId: "acct-1",
			platformMessageId: "msg-1",
			scope: "shared",
			discord: {
				userId: "user-123",
			},
			...metadataOverrides,
		},
	} as unknown as Memory;
}

describe("provenance conflict-field rejection", () => {
	describe("accountId conflict", () => {
		it("rejects when metadata.accountId differs from nested discord.accountId", () => {
			const mem = makeMemory({
				accountId: "acct-top-level",
				discord: {
					userId: "user-123",
					accountId: "acct-nested-different",
				},
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("invalid_provenance");
				expect(result.reason).toContain("conflicting connector account id");
			}
		});

		it("accepts when metadata.accountId matches nested accountId", () => {
			const mem = makeMemory({
				accountId: "acct-same",
				discord: {
					userId: "user-123",
					accountId: "acct-same",
				},
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
		});

		it("accepts when only one path has accountId", () => {
			const mem = makeMemory({
				discord: {
					userId: "user-123",
				},
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.accountId).toBe("acct-1");
			}
		});
	});

	describe("platformMessageId conflict", () => {
		it("rejects when metadata.platformMessageId differs from nested discord.messageId", () => {
			const mem = makeMemory({
				platformMessageId: "msg-001",
				discord: {
					userId: "user-123",
					messageId: "msg-002-different",
				},
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("invalid_provenance");
				expect(result.reason).toContain("conflicting platform message id");
			}
		});

		it("ignores metadata.sourceId when an authoritative message id is present", () => {
			// sourceId is a derived/internal identifier (the Discord connector
			// writes a synthesized memory-source UUID there), NOT the platform
			// record id, so it is only a last-resort fallback and must never be
			// diffed against a real message id. A real Discord ingestion always
			// carries messageIdFull alongside a differing sourceId.
			const mem = makeMemory({
				platformMessageId: undefined,
				messageIdFull: "msg-full-001",
				sourceId: "msg-src-002-different",
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.platformMessageId).toBe("msg-full-001");
			}
		});

		it("falls back to metadata.sourceId only when no authoritative id exists", () => {
			const mem = makeMemory({
				platformMessageId: undefined,
				messageIdFull: undefined,
				sourceId: "msg-src-fallback",
			});
			delete (mem.metadata as Record<string, unknown>).discord;

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.platformMessageId).toBe("msg-src-fallback");
			}
		});

		it("accepts when only one path has platformMessageId", () => {
			const mem = makeMemory({});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.platformMessageId).toBe("msg-1");
			}
		});
	});

	describe("scope conflict", () => {
		it("rejects when metadata.base.scope differs from metadata.scope", () => {
			const mem = makeMemory({
				base: { scope: "private" },
				scope: "shared",
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.code).toBe("invalid_provenance");
				expect(result.reason).toContain("conflicting scope");
			}
		});

		it("accepts when metadata.base.scope matches metadata.scope", () => {
			const mem = makeMemory({
				base: { scope: "shared" },
				scope: "shared",
			});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.scope).toBe("shared");
			}
		});

		it("accepts when only one path has scope", () => {
			const mem = makeMemory({});

			const result = deriveCanonicalProvenance(mem, AGENT_ID);
			expect(result.valid).toBe(true);
			if (result.valid) {
				expect(result.provenance.scope).toBe("shared");
			}
		});
	});
});
