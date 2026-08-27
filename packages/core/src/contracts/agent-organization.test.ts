/**
 * Exercises the host-neutral organization aggregate as a deterministic command boundary.
 */

import { describe, expect, it } from "vitest";
import {
	applyOrganizationCommand,
	createOrganizationRecord,
	InMemoryOrganizationStore,
	parseAgentOrganizationRecord,
	sponsorOnlyOrganizationAuthorizer,
	toOrganizationCommandId,
	toOrganizationId,
	toOrganizationPrincipalId,
	toOrganizationTimestamp,
} from "./agent-organization";

const create = {
	organizationId: toOrganizationId("org-acme"),
	commandId: toOrganizationCommandId("command-create"),
	expectedRevision: 0,
	actorPrincipalId: toOrganizationPrincipalId("principal-sponsor"),
	issuedAt: toOrganizationTimestamp("2026-08-27T10:00:00.000Z"),
	command: {
		type: "create_organization" as const,
		name: "Acme agents",
		goal: "Sell elizaOS as an embeddable agentic OS",
	},
};

describe("agent organization aggregate", () => {
	it("commits snapshot, command receipt, and audit entry in one revision", () => {
		const result = createOrganizationRecord(create);

		expect(result.replayed).toBe(false);
		expect(result.record.revision).toBe(1);
		expect(result.record.receipts).toHaveLength(1);
		expect(result.record.audit).toHaveLength(1);
		expect(result.record.receipts[0]?.resultingRevision).toBe(1);
		expect(result.record.audit[0]?.revision).toBe(1);
	});

	it("returns the prior result for exact duplicate delivery", async () => {
		const first = createOrganizationRecord(create);
		const duplicate = await applyOrganizationCommand(
			first.record,
			create,
			sponsorOnlyOrganizationAuthorizer,
		);

		expect(duplicate.replayed).toBe(true);
		expect(duplicate.record).toEqual(first.record);
	});

	it("rejects stale writers without changing the record", async () => {
		const first = createOrganizationRecord(create);
		const stale = {
			...create,
			commandId: toOrganizationCommandId("command-rename"),
			expectedRevision: 0,
			command: { type: "rename_organization" as const, name: "New name" },
		};

		await expect(
			applyOrganizationCommand(
				first.record,
				stale,
				sponsorOnlyOrganizationAuthorizer,
			),
		).rejects.toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_REVISION_CONFLICT" }),
		);
		expect(first.record.organization.name).toBe("Acme agents");
	});

	it("rejects reuse of a command id with different content", async () => {
		const first = createOrganizationRecord(create);
		const collision = {
			...create,
			command: { ...create.command, name: "Hostile replacement" },
		};

		await expect(
			applyOrganizationCommand(
				first.record,
				collision,
				sponsorOnlyOrganizationAuthorizer,
			),
		).rejects.toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_COMMAND_ID_COLLISION" }),
		);
	});

	it("denies non-sponsor mutation until delegated authority is integrated", async () => {
		const first = createOrganizationRecord(create);
		await expect(
			applyOrganizationCommand(
				first.record,
				{
					...create,
					commandId: toOrganizationCommandId("hostile-rename"),
					expectedRevision: 1,
					actorPrincipalId: toOrganizationPrincipalId("principal-outsider"),
					command: { type: "rename_organization", name: "Taken over" },
				},
				sponsorOnlyOrganizationAuthorizer,
			),
		).rejects.toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_MUTATION_DENIED" }),
		);
	});

	it("applies the injected authorization policy to organization creation", async () => {
		const store = new InMemoryOrganizationStore(() => false);

		await expect(store.apply(create)).rejects.toMatchObject({
			code: "ORGANIZATION_MUTATION_DENIED",
		});
		expect(await store.get(create.organizationId)).toBeNull();
	});

	it("rechecks authorization before returning an idempotent replay", async () => {
		const first = createOrganizationRecord(create);
		let called = false;

		await expect(
			applyOrganizationCommand(first.record, create, async () => {
				called = true;
				return false;
			}),
		).rejects.toMatchObject({ code: "ORGANIZATION_MUTATION_DENIED" });
		expect(called).toBe(true);
	});

	it("classifies malformed persisted identifiers as store corruption", () => {
		const malformed = structuredClone(
			createOrganizationRecord(create).record,
		) as unknown as Record<string, unknown>;
		const organization = malformed.organization as Record<string, unknown>;
		organization.id = " ";

		expect(() => parseAgentOrganizationRecord(malformed)).toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_STORE_CORRUPT" }),
		);
	});

	it("rejects duplicate persisted command ids", async () => {
		const first = createOrganizationRecord(create).record;
		const second = (
			await applyOrganizationCommand(
				first,
				{
					...create,
					commandId: toOrganizationCommandId("rename"),
					expectedRevision: 1,
					command: { type: "rename_organization", name: "Renamed" },
				},
				sponsorOnlyOrganizationAuthorizer,
			)
		).record;
		const duplicate = structuredClone(second);
		const duplicateId = duplicate.receipts[0]?.commandId;
		if (!duplicateId || !duplicate.receipts[1] || !duplicate.audit[1]) {
			throw new Error("test fixture history is incomplete");
		}
		duplicate.receipts[1].commandId = duplicateId;
		duplicate.audit[1].commandId = duplicateId;

		expect(() => parseAgentOrganizationRecord(duplicate)).toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_STORE_CORRUPT" }),
		);
	});

	it("rejects a receipt whose fingerprint does not prove its stored envelope", () => {
		const corrupted = structuredClone(createOrganizationRecord(create).record);
		const receipt = corrupted.receipts[0];
		if (!receipt) throw new Error("test fixture receipt is missing");
		receipt.commandFingerprint = "garbage";

		expect(() => parseAgentOrganizationRecord(corrupted)).toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_STORE_CORRUPT" }),
		);
	});

	it("persists a canonical envelope when command text has surrounding whitespace", () => {
		const record = createOrganizationRecord({
			...create,
			command: {
				...create.command,
				name: "  Acme agents  ",
				goal: "  Sell safely  ",
			},
		}).record;

		expect(parseAgentOrganizationRecord(record).organization).toMatchObject({
			name: "Acme agents",
			goal: "Sell safely",
		});
	});

	it("drops unknown envelope metadata before persistence", () => {
		const withMetadata = {
			...create,
			traceId: "harmless-metadata",
		};
		const record = createOrganizationRecord(withMetadata).record;

		expect(parseAgentOrganizationRecord(record)).toEqual(record);
		expect(record.receipts[0]?.commandEnvelope).not.toHaveProperty("traceId");
	});

	it("rejects a persisted snapshot that diverges from command history", () => {
		const forged = structuredClone(createOrganizationRecord(create).record);
		forged.organization.sponsorPrincipalId =
			toOrganizationPrincipalId("principal-attacker");
		forged.organization.goal = "Forged goal";

		expect(() => parseAgentOrganizationRecord(forged)).toThrowError(
			expect.objectContaining({ code: "ORGANIZATION_STORE_CORRUPT" }),
		);
	});

	it("serializes concurrent in-memory commands against the latest revision", async () => {
		const store = new InMemoryOrganizationStore();
		await store.apply(create);
		const outcomes = await Promise.allSettled([
			store.apply({
				...create,
				commandId: toOrganizationCommandId("rename-alpha"),
				expectedRevision: 1,
				command: { type: "rename_organization", name: "Alpha" },
			}),
			store.apply({
				...create,
				commandId: toOrganizationCommandId("rename-beta"),
				expectedRevision: 1,
				command: { type: "rename_organization", name: "Beta" },
			}),
		]);

		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
		expect((await store.get(toOrganizationId("org-acme")))?.revision).toBe(2);
	});
});
