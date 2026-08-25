/**
 * Deterministic unit coverage for fact-candidate persistence, including adapter
 * availability, optional fields, SQL escaping, and database failure propagation.
 */
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, UUID } from "../../../types/index.ts";
import {
	type FactCandidateRecord,
	recordFactCandidate,
} from "./_factCandidates.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const EXISTING_FACT_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;
const EVIDENCE_MESSAGE_ID = "00000000-0000-4000-8000-0000000000dd" as UUID;

function makeRuntime(db: unknown): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		adapter: { db },
	} as unknown as IAgentRuntime;
}

function rawSqlText(query: unknown): string {
	const chunks = (query as { queryChunks: Array<{ value: string[] }> })
		.queryChunks;
	return chunks.flatMap((chunk) => chunk.value).join("");
}

describe("recordFactCandidate", () => {
	it("does nothing when the runtime database is unavailable", async () => {
		await expect(
			recordFactCandidate(makeRuntime(undefined), {
				entityId: ENTITY_ID,
				kind: "merge",
				proposedText: "The user lives in Berlin",
			}),
		).resolves.toBeUndefined();

		await expect(
			recordFactCandidate(makeRuntime({ execute: "not callable" }), {
				entityId: ENTITY_ID,
				kind: "merge",
				proposedText: "The user lives in Berlin",
			}),
		).resolves.toBeUndefined();
	});

	it("inserts a complete contradiction candidate with escaped SQL literals", async () => {
		const execute = vi.fn(async () => undefined);
		const candidate: FactCandidateRecord = {
			entityId: ENTITY_ID,
			kind: "contradict",
			existingFactId: EXISTING_FACT_ID,
			proposedText: "The user's home is Paris",
			reason: "The user said they're moving",
			evidenceMessageId: EVIDENCE_MESSAGE_ID,
		};

		await recordFactCandidate(makeRuntime({ execute }), candidate);

		expect(execute).toHaveBeenCalledTimes(1);
		const sqlText = rawSqlText(execute.mock.calls[0]?.[0]);
		expect(sqlText).toContain(`'${AGENT_ID}'`);
		expect(sqlText).toContain(`'${ENTITY_ID}'`);
		expect(sqlText).toContain("'contradict'");
		expect(sqlText).toContain(`'${EXISTING_FACT_ID}'`);
		expect(sqlText).toContain("'The user''s home is Paris'");
		expect(sqlText).toContain("0.6");
		expect(sqlText).toContain(
			`'{"reason":"The user said they''re moving","evidenceMessageId":"${EVIDENCE_MESSAGE_ID}"}'::jsonb`,
		);
		expect(sqlText).toContain("'pending'");
	});

	it("uses NULL and an empty evidence object when optional fields are absent", async () => {
		const execute = vi.fn(async () => undefined);

		await recordFactCandidate(makeRuntime({ execute }), {
			entityId: ENTITY_ID,
			kind: "merge",
			proposedText: "The user lives in Berlin",
		});

		const sqlText = rawSqlText(execute.mock.calls[0]?.[0]);
		expect(sqlText).toContain("'merge'");
		expect(sqlText).toMatch(/'merge',\s+NULL,\s+'The user lives in Berlin'/);
		expect(sqlText).toContain("'{}'::jsonb");
	});

	it("propagates database execution failures", async () => {
		const failure = new Error("database unavailable");
		const execute = vi.fn(async () => {
			throw failure;
		});

		await expect(
			recordFactCandidate(makeRuntime({ execute }), {
				entityId: ENTITY_ID,
				kind: "merge",
				proposedText: "The user lives in Berlin",
			}),
		).rejects.toBe(failure);
	});
});
