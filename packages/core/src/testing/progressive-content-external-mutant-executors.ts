/**
 * Executes cross-seam progressive-content mutants through production render,
 * dispatch-admission, and continuity-ledger oracles. Each executor throws its
 * registry vector only after the owning oracle has observed the injected defect.
 */

import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.ts";
import { ElizaError } from "../errors.ts";
import {
	loadSessionSummaryContentLedger,
	publishSessionSummaryContentManifests,
} from "../features/advanced-memory/session-summary-content-manifest.ts";
import { renderActionResultsForModel } from "../runtime/planner-rendering.ts";
import { createPreparedModelRequestGuard } from "../runtime/prepared-model-request.ts";
import type { CompactionContentManifest } from "../types/content-manifest.ts";
import type { Memory } from "../types/memory.ts";
import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { createHash } from "../utils/crypto-compat.ts";
import { stringToUuid } from "../utils.ts";
import type {
	ProgressiveContentExternalMutantExecutor,
	ProgressiveContentExternalMutantId,
} from "./progressive-content-mutants.ts";

type CoreExternalMutantId = Exclude<
	ProgressiveContentExternalMutantId,
	| "readback-artifact-identity-reexternalized"
	| "selected-live-credentials-become-skip"
>;

class MutantKilledError extends Error {
	readonly vector: string;

	constructor(vector: string, cause: unknown) {
		super(`Progressive-content mutant rejected by ${vector}`, { cause });
		this.name = "MutantKilledError";
		this.vector = vector;
	}
}

function rejectAfterObservedFailure(
	vector: string,
	operation: () => void,
	expectedCode?: string,
): void {
	try {
		operation();
	} catch (cause) {
		if (
			expectedCode !== undefined &&
			(!(cause instanceof ElizaError) || cause.code !== expectedCode)
		) {
			throw cause;
		}
		throw new MutantKilledError(vector, cause);
	}
	throw new Error(`mutated operation unexpectedly passed ${vector}`);
}

async function rejectAfterObservedAsyncFailure(
	vector: string,
	operation: () => Promise<unknown>,
	expectedCode: string,
): Promise<never> {
	try {
		await operation();
	} catch (cause) {
		if (!(cause instanceof ElizaError) || cause.code !== expectedCode) {
			throw cause;
		}
		throw new MutantKilledError(vector, cause);
	}
	throw new Error(`mutated operation unexpectedly passed ${vector}`);
}

function duplicateBodyExecutor(): ProgressiveContentExternalMutantExecutor {
	return {
		execute() {
			const marker = "MUTANT_DUPLICATED_BODY_7d396c";
			const mutated = renderActionResultsForModel([
				{
					success: true,
					text: marker,
					data: { actionName: "READ", body: marker },
				},
			]);
			rejectAfterObservedFailure("serializer-duplication", () => {
				const occurrences = mutated.text.split(marker).length - 1;
				if (occurrences !== 1) {
					throw new ElizaError("Action-result body reached the model twice", {
						code: "MODEL_ACTION_RESULT_DUPLICATED",
						context: { occurrences },
					});
				}
			});
		},
	};
}

function firstItemStarvationExecutor(): ProgressiveContentExternalMutantExecutor {
	return {
		execute() {
			const source = ["FAIR_ITEM_ALPHA", "FAIR_ITEM_BETA", "FAIR_ITEM_GAMMA"];
			const mutated = renderActionResultsForModel(
				source.slice(1).map((identity) => ({
					success: true,
					text: identity,
					data: { actionName: "READ" },
				})),
			);
			rejectAfterObservedFailure("fairness", () => {
				const missing = source.filter(
					(identity) => !mutated.text.includes(identity),
				);
				if (missing.length > 0) {
					throw new ElizaError("Model projection starved a source item", {
						code: "MODEL_ACTION_RESULT_STARVATION",
						context: { missing },
					});
				}
			});
		},
	};
}

function finalWireExecutor(): ProgressiveContentExternalMutantExecutor {
	return {
		execute() {
			const prematureProjection = JSON.stringify({ messages: [] });
			const completeRequest = JSON.stringify({
				messages: [{ role: "user", content: "x".repeat(256) }],
			});
			if (new TextEncoder().encode(prematureProjection).byteLength >= 48) {
				throw new Error("final-wire mutant fixture is not below admission");
			}
			rejectAfterObservedFailure(
				"final-wire-budget",
				() => {
					createPreparedModelRequestGuard({
						provider: "mutant-provider",
						model: "mutant-model",
						serializeRequest: () => completeRequest,
						contextWindowTokens: 64,
						outputReserveTokens: 16,
						countInputTokens: (serialized) =>
							new TextEncoder().encode(serialized).byteLength,
						countInputTokensIsExact: true,
					});
				},
				"MODEL_INPUT_OVER_BUDGET",
			);
		},
	};
}

const continuityAgentId = stringToUuid("external-mutant-continuity-agent");
const continuityRoomId = stringToUuid("external-mutant-continuity-room");
const continuityEntityId = stringToUuid("external-mutant-continuity-entity");

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function continuityManifest(): CompactionContentManifest {
	return {
		schemaVersion: 1,
		contentRefs: Array.from({ length: 100 }, (_, index) => ({
			reference: {
				kind: "document" as const,
				ref: `document:${stringToUuid(`external-mutant-${index}`)}`,
				revision: "revision-1",
				resumability: "restart-safe" as const,
			},
			revision: "revision-1",
			reason: `tool:READ:${"detail".repeat(index % 5)}`,
			rangesUsed: [
				{ unit: "byte" as const, start: index * 10, end: index * 10 + 9 },
			],
			lastUsedAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index)).toISOString(),
			retained: true,
		})),
		modifiedFiles: [],
		pendingProcesses: [],
	};
}

function cloneMemory(memory: Memory): Memory {
	return structuredClone(memory);
}

function withContent(memory: Memory, content: Record<string, unknown>): Memory {
	const copy = cloneMemory(memory);
	copy.content = { ...copy.content, text: JSON.stringify(content) };
	return copy;
}

function rebindHead(
	headMemory: Memory,
	update: (head: Record<string, unknown>) => void,
): { memory: Memory; head: Record<string, unknown> } {
	const head = JSON.parse(String(headMemory.content.text)) as Record<
		string,
		unknown
	>;
	update(head);
	const {
		schemaVersion: _schemaVersion,
		headRevision: _headRevision,
		...seed
	} = head;
	head.headRevision = sha256(seed);
	const memory = withContent(headMemory, head);
	memory.metadata = {
		...memory.metadata,
		revision: head.headRevision as string,
	} as Memory["metadata"];
	return { memory, head };
}

type ContinuityMutantId = Extract<
	CoreExternalMutantId,
	`canonical-${string}` | `manifest-${string}`
>;

async function executeContinuityMutant(
	mutantId: ContinuityMutantId,
): Promise<never> {
	const adapter = new InMemoryDatabaseAdapter();
	const baseRuntime = {
		agentId: continuityAgentId,
		adapter,
		getMemoryById: async (id: UUID) =>
			(await adapter.getMemoriesByIds([id]))[0] ?? null,
	} as unknown as IAgentRuntime;
	const envelope = await publishSessionSummaryContentManifests({
		runtime: baseRuntime,
		roomId: continuityRoomId,
		entityId: continuityEntityId,
		manifests: [continuityManifest()],
	});
	if (!envelope || envelope.shardCount < 3) {
		throw new Error("continuity mutant fixture did not create three shards");
	}
	const headMemory = await baseRuntime.getMemoryById(envelope.headMemoryId);
	if (!headMemory) throw new Error("continuity mutant head is missing");
	const originalHead = JSON.parse(String(headMemory.content.text)) as Record<
		string,
		unknown
	>;
	const topId = originalHead.firstShardId as UUID;
	const topMemory = await baseRuntime.getMemoryById(topId);
	if (!topMemory) throw new Error("continuity mutant top shard is missing");
	const top = JSON.parse(String(topMemory.content.text)) as Record<
		string,
		unknown
	>;
	const secondId = top.nextShardId as UUID;
	const secondMemory = await baseRuntime.getMemoryById(secondId);
	if (!secondMemory)
		throw new Error("continuity mutant second shard is missing");
	const second = JSON.parse(String(secondMemory.content.text)) as Record<
		string,
		unknown
	>;
	const thirdId = second.nextShardId as UUID;
	const thirdMemory = await baseRuntime.getMemoryById(thirdId);
	if (!thirdMemory) throw new Error("continuity mutant third shard is missing");
	const third = JSON.parse(String(thirdMemory.content.text)) as Record<
		string,
		unknown
	>;

	const mutatedTop = structuredClone(top);
	let mutatedSecond: Record<string, unknown> | undefined;
	let head = structuredClone(originalHead);
	let mutateTopReads = true;

	switch (mutantId) {
		case "canonical-ledger-count-eviction":
			mutatedTop.records = (mutatedTop.records as unknown[]).slice(1);
			break;
		case "canonical-ledger-byte-eviction": {
			const records = structuredClone(
				mutatedTop.records as Array<Record<string, unknown>>,
			);
			const first = records[0];
			const value = first.value as Record<string, unknown>;
			value.reason = "tool:R";
			mutatedTop.records = records;
			break;
		}
		case "manifest-next-link-broken":
			mutatedTop.nextShardId = stringToUuid("external-mutant-missing-shard");
			mutatedTop.nextShardDigest = "0".repeat(64);
			break;
		case "manifest-next-link-skip":
			mutatedTop.nextShardId = thirdId;
			mutatedTop.nextShardDigest = sha256(third);
			break;
		case "manifest-next-link-repeat":
			mutatedTop.nextShardId = topId;
			mutatedTop.nextShardDigest = sha256(top);
			mutateTopReads = false;
			break;
		case "manifest-next-link-loop":
			mutatedSecond = structuredClone(second);
			mutatedSecond.nextShardId = topId;
			mutatedSecond.nextShardDigest = sha256(top);
			mutatedTop.nextShardDigest = sha256(mutatedSecond);
			break;
		case "manifest-shard-reorder":
			mutatedTop.position = (mutatedTop.position as number) - 1;
			break;
		case "manifest-shard-digest-mismatch":
			mutatedTop.publicationDigest = "f".repeat(64);
			break;
	}

	if (mutantId !== "manifest-shard-digest-mismatch") {
		const rebound = rebindHead(headMemory, (candidate) => {
			candidate.firstShardDigest = sha256(mutatedTop);
		});
		head = rebound.head;
	}
	const mutatedHeadMemory = withContent(headMemory, head);
	mutatedHeadMemory.metadata = {
		...mutatedHeadMemory.metadata,
		revision: head.headRevision as string,
	} as Memory["metadata"];
	const mutatedEnvelope = {
		...envelope,
		headRevision: head.headRevision as string,
	};
	let topReads = 0;
	const runtime = {
		...baseRuntime,
		getMemoryById: async (id: UUID) => {
			if (id === envelope.headMemoryId) return cloneMemory(mutatedHeadMemory);
			if (id === topId) {
				topReads += 1;
				if (mutateTopReads || topReads === 1)
					return withContent(topMemory, mutatedTop);
			}
			if (id === secondId && mutatedSecond)
				return withContent(secondMemory, mutatedSecond);
			return baseRuntime.getMemoryById(id);
		},
	} as unknown as IAgentRuntime;
	const expectedCode: Record<ContinuityMutantId, string> = {
		"canonical-ledger-count-eviction": "CONTENT_CONTINUITY_LEDGER_MISMATCH",
		"canonical-ledger-byte-eviction": "CONTENT_CONTINUITY_LEDGER_MISMATCH",
		"manifest-next-link-broken": "CONTENT_CONTINUITY_SHARD_MISSING",
		"manifest-next-link-skip": "CONTENT_CONTINUITY_ORDER_MISMATCH",
		"manifest-next-link-repeat": "CONTENT_CONTINUITY_CYCLE",
		"manifest-next-link-loop": "CONTENT_CONTINUITY_CYCLE",
		"manifest-shard-reorder": "CONTENT_CONTINUITY_ORDER_MISMATCH",
		"manifest-shard-digest-mismatch": "CONTENT_CONTINUITY_DIGEST_MISMATCH",
	};
	return rejectAfterObservedAsyncFailure(
		"continuity-loss",
		async () => {
			await loadSessionSummaryContentLedger(
				runtime,
				mutatedEnvelope,
				continuityRoomId,
			);
		},
		expectedCode[mutantId],
	);
}

function continuityVector(
	id: ContinuityMutantId,
): "continuity-loss" | "manifest-chain" {
	return id.startsWith("canonical-") ? "continuity-loss" : "manifest-chain";
}

/** Build production-backed executors for every core-owned external seam. */
export function createCoreProgressiveContentExternalMutantExecutors(): Record<
	CoreExternalMutantId,
	ProgressiveContentExternalMutantExecutor
> {
	const continuityIds: readonly ContinuityMutantId[] = [
		"canonical-ledger-count-eviction",
		"canonical-ledger-byte-eviction",
		"manifest-next-link-broken",
		"manifest-next-link-skip",
		"manifest-next-link-repeat",
		"manifest-next-link-loop",
		"manifest-shard-reorder",
		"manifest-shard-digest-mismatch",
	];
	const continuity = Object.fromEntries(
		continuityIds.map((id) => [
			id,
			{
				async execute() {
					try {
						await executeContinuityMutant(id);
					} catch (error) {
						if (error instanceof MutantKilledError) {
							throw new MutantKilledError(continuityVector(id), error.cause);
						}
						throw error;
					}
				},
			},
		]),
	) as Record<ContinuityMutantId, ProgressiveContentExternalMutantExecutor>;
	return {
		"duplicate-body-through-data": duplicateBodyExecutor(),
		"first-item-starvation": firstItemStarvationExecutor(),
		"budget-before-final-serialization": finalWireExecutor(),
		...continuity,
	};
}
