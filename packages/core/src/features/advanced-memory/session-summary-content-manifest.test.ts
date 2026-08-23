/** Exercises immutable session-summary rollover, CAS, and fail-closed traversal. */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter.ts";
import type { CompactionContentManifest } from "../../types/content-manifest.ts";
import type { UUID } from "../../types/primitives.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { createHash } from "../../utils/crypto-compat.ts";
import { stringToUuid } from "../../utils.ts";
import {
	loadSessionSummaryContentLedger,
	mergeSessionSummaryMetadata,
	parseSessionSummaryContentEnvelope,
	publishSessionSummaryContentManifests,
	renderSessionSummaryContentLedger,
	SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY,
} from "./session-summary-content-manifest.ts";

const agentId = stringToUuid("continuity-agent");
const roomId = stringToUuid("continuity-room");
const entityId = stringToUuid("continuity-entity");
const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

function manifest(
	start: number,
	count: number,
	reason = "tool:document",
): CompactionContentManifest {
	return {
		schemaVersion: 1,
		contentRefs: Array.from({ length: count }, (_, offset) => ({
			reference: {
				kind: "document" as const,
				ref: `document:${stringToUuid(`doc-${start + offset}`)}`,
				revision: "rev-1",
			},
			revision: "rev-1",
			reason,
			rangesUsed: [
				{
					unit: "byte" as const,
					start: (start + offset) * 10,
					end: (start + offset) * 10 + 9,
				},
			],
			lastUsedAt: new Date(
				Date.UTC(2026, 7, 22, 0, 0, start + offset),
			).toISOString(),
			retained: true,
		})),
		modifiedFiles: [],
		pendingProcesses: [],
	};
}
function harness() {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = {
		agentId,
		adapter,
		getMemoryById: async (id: UUID) =>
			(await adapter.getMemoriesByIds([id]))[0] ?? null,
	} as unknown as IAgentRuntime;
	return { adapter, runtime };
}
async function publish(
	runtime: IAgentRuntime,
	value: CompactionContentManifest,
) {
	const envelope = await publishSessionSummaryContentManifests({
		runtime,
		roomId,
		entityId,
		manifests: [value],
	});
	if (!envelope) throw new Error("fixture publication unexpectedly empty");
	return envelope;
}
async function mutateFirstShard(
	adapter: InMemoryDatabaseAdapter,
	runtime: IAgentRuntime,
	envelope: Awaited<ReturnType<typeof publish>>,
	mutate: (shard: Record<string, unknown>, shardId: UUID) => void,
) {
	const headMemory = await runtime.getMemoryById(envelope.headMemoryId);
	if (!headMemory?.content.text) throw new Error("fixture head missing");
	const head = JSON.parse(headMemory.content.text) as Record<string, unknown>;
	const shardId = head.firstShardId as UUID;
	const shardMemory = await runtime.getMemoryById(shardId);
	if (!shardMemory?.content.text) throw new Error("fixture shard missing");
	const shard = JSON.parse(shardMemory.content.text) as Record<string, unknown>;
	mutate(shard, shardId);
	await adapter.updateMemories([
		{ id: shardId, content: { text: JSON.stringify(shard) } },
	]);
	head.firstShardDigest = digest(shard);
	const {
		schemaVersion: _schemaVersion,
		headRevision: _headRevision,
		...seed
	} = head;
	head.headRevision = digest(seed);
	await adapter.updateMemories([
		{
			id: envelope.headMemoryId,
			content: { text: JSON.stringify(head) },
			metadata: { type: "custom", revision: head.headRevision as string },
		},
	]);
	return { ...envelope, headRevision: head.headRevision as string };
}

describe("session-summary immutable content ledger", () => {
	it("recovers every ordered record after repeated count and byte rollover", async () => {
		const { runtime } = harness();
		await publish(runtime, manifest(0, 200));
		await publish(runtime, manifest(200, 200, `tool:${"x".repeat(300)}`));
		const envelope = await publish(runtime, manifest(400, 200));
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			envelope,
			roomId,
		);
		expect(ledger.records).toHaveLength(600);
		expect(ledger.envelope.shardCount).toBeGreaterThan(18);
		expect(
			ledger.records.map((record) =>
				record.kind === "content-reference" ? record.value.reference.ref : "",
			),
		).toEqual(
			Array.from(
				{ length: 600 },
				(_, index) => `document:${stringToUuid(`doc-${index}`)}`,
			),
		);
	});

	it("is idempotent on retry and CAS-safe for concurrent writers", async () => {
		const { runtime } = harness();
		const first = manifest(0, 1);
		const firstEnvelope = await publish(runtime, first);
		expect(await publish(runtime, first)).toEqual(firstEnvelope);
		await Promise.all([
			publish(runtime, manifest(1, 1)),
			publish(runtime, manifest(2, 1)),
		]);
		await publish(runtime, first);
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			await publish(runtime, manifest(3, 1)),
			roomId,
		);
		expect(ledger.records).toHaveLength(4);
		expect(
			new Set(
				ledger.records.map((record) =>
					record.kind === "content-reference" ? record.value.reference.ref : "",
				),
			).size,
		).toBe(4);
	});

	it("preserves ranges across the canonical per-record ceiling", async () => {
		const { runtime } = harness();
		let envelope: Awaited<ReturnType<typeof publish>> | undefined;
		for (let batch = 0; batch < 3; batch += 1) {
			const value = manifest(999, 1);
			value.contentRefs[0].rangesUsed = Array.from(
				{ length: 64 },
				(_, index) => ({
					unit: "byte",
					start: batch * 1000 + index * 2,
					end: batch * 1000 + index * 2 + 1,
				}),
			);
			value.contentRefs[0].lastUsedAt = new Date(
				Date.UTC(2026, 7, 22, 0, batch),
			).toISOString();
			envelope = await publish(runtime, value);
		}
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			envelope,
			roomId,
		);
		expect(
			ledger.records.flatMap((record) =>
				record.kind === "content-reference" ? record.value.rangesUsed : [],
			),
		).toHaveLength(192);
	});

	it.each([
		[
			"reorder",
			(shard: Record<string, unknown>) => {
				shard.position = (shard.position as number) - 1;
			},
			/order\/skip/u,
		],
		[
			"skip",
			(shard: Record<string, unknown>) => {
				shard.nextShardId = stringToUuid("missing-shard");
				shard.nextShardDigest = "0".repeat(64);
			},
			/missing/u,
		],
		[
			"cycle/repeat",
			(shard: Record<string, unknown>, shardId: UUID) => {
				shard.nextShardId = shardId;
				shard.nextShardDigest = "0".repeat(64);
			},
			/cycle\/repeat/u,
		],
	])(
		"rejects a %s mutant instead of returning a prefix",
		async (_name, mutate, expected) => {
			const { adapter, runtime } = harness();
			const changed = await mutateFirstShard(
				adapter,
				runtime,
				await publish(runtime, manifest(0, 40)),
				mutate,
			);
			await expect(
				loadSessionSummaryContentLedger(runtime, changed, roomId),
			).rejects.toThrow(expected);
		},
	);

	it("rejects unknown pointer fields and bounds only prompt projection", async () => {
		const { runtime } = harness();
		const envelope = await publish(
			runtime,
			manifest(0, 40, "SOURCE BODY MUST NOT RENDER"),
		);
		const metadata = mergeSessionSummaryMetadata(
			{ owner: "memory" },
			["point"],
			envelope,
		);
		expect(() =>
			parseSessionSummaryContentEnvelope({
				...metadata,
				[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
					...envelope,
					unknown: true,
				} as never,
			}),
		).toThrow(/unsupported field/u);
		const ledger = await loadSessionSummaryContentLedger(
			runtime,
			parseSessionSummaryContentEnvelope(metadata),
			roomId,
		);
		const rendered = renderSessionSummaryContentLedger(ledger, {
			maxRecords: 2,
			maxCharacters: 250,
		});
		expect(rendered.length).toBeLessThanOrEqual(250);
		expect(rendered).not.toContain("SOURCE BODY MUST NOT RENDER");
		expect(ledger.records).toHaveLength(40);
		await expect(
			loadSessionSummaryContentLedger(
				runtime,
				envelope,
				stringToUuid("another-room"),
			),
		).rejects.toThrow(/authorized room/u);
	});
});
