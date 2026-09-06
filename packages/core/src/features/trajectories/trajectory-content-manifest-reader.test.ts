/**
 * Production consumption of the durable content-manifest ledger (#25141
 * review): the persisted shard ledger must be written AND read by the real
 * TrajectoriesService surfaces, not by direct helper calls. The writer phase
 * drives the real public capture pipeline — startTrajectory → startStep →
 * logSemanticStage (tool-result carrier) → endTrajectory — which derives and
 * publishes the ledger through the production publish path. The writer
 * service is then fully disposed; a completely FRESH service instance (fresh
 * in-memory maps, same shared adapter cache domain — the durable bytes)
 * reloads and fully verifies every shard through the production detail
 * reader (getTrajectoryDetail) and surfaces the entries as
 * metadata.contentManifest. Missing ledgers report the honest empty array;
 * damaged ledgers surface an explicit unavailable marker. Real service +
 * real adapter storage throughout; only the SQL row store is an in-memory
 * harness (the service's own established executeRawSql-override idiom).
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import type { IAgentRuntime } from "../../types";
import type { CompactionContentEntry } from "../../types/content-manifest";
import { TrajectoriesService } from "./TrajectoriesService";

const AGENT_ID = "00000000-0000-4000-8000-0000000000aa";

/** Deterministic 64-hex digest for slice identity (Web Crypto is async). */
function sha256Hex(input: string): string {
	// FNV-1a based pseudo-digest: tests only need a stable, unique,
	// hex-64 token per (ref,start,end) — not cryptographic strength.
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < input.length; i++) {
		h1 ^= input.charCodeAt(i);
		h1 = Math.imul(h1, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ input.charCodeAt(i), 0x85ebca6b) >>> 0;
	}
	const chunk = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
	const mix = h2 ^ 0xdeadbeef;
	const mix2 = h1 ^ 0x9e3779b9;
	return `${chunk(h1)}${chunk(h2)}${chunk(h1 ^ h2)}${chunk(Math.imul(h1, h2))}${chunk(mix)}${chunk(mix2)}${chunk(h2 + h1)}${chunk(h1 + h2 + 0x1337)}`;
}

const TRAJECTORY_COLUMNS = [
	"scenario_id",
	"trace_id",
	"episode_id",
	"batch_id",
	"group_index",
	"steps_json",
	"reward_components_json",
	"metrics_json",
	"metadata_json",
	"total_cache_read_input_tokens",
	"total_cache_creation_input_tokens",
	"is_training_data",
	"is_evaluation",
	"used_in_training",
	"judged_at",
];

/**
 * Normalize a SQL statement to text: the service's direct path passes the
 * raw string; the transaction path passes a Drizzle `sql.raw` object whose
 * queryChunks are {value:[text]} records.
 */
function sqlTextOf(rawSql: unknown): string {
	if (typeof rawSql === "string") return rawSql;
	const chunks = (rawSql as { queryChunks?: unknown[] }).queryChunks;
	if (!Array.isArray(chunks)) return String(rawSql);
	return chunks
		.map((chunk) => {
			const value = (chunk as { value?: unknown }).value;
			return Array.isArray(value) ? value.join("") : String(chunk);
		})
		.join("");
}

/**
 * Minimal durable SQL row store: trajectories + trajectory_step_index tables
 * as Maps, addressed by the same SQL shapes the service issues (INSERT /
 * UPDATE ... WHERE id / SELECT * / step-index upserts). This is the harness
 * stand-in for the SQL database only — every cache-domain byte the ledger
 * touches goes through the REAL InMemoryDatabaseAdapter.
 */
class MiniTrajectoryDb {
	trajectories = new Map<string, Record<string, unknown>>();
	stepIndex = new Map<string, Record<string, unknown>>();

	private insertTrajectory(sqlText: string): void {
		const _id = this.sqlStringAfter(sqlText, "VALUES")[0];
		// INSERT column order is stable in startTrajectory: id is the first value.
		const values = sqlText.slice(sqlText.indexOf("VALUES"));
		const ids = this.stringLiterals(values);
		this.trajectories.set(ids[0], {
			id: ids[0],
			agent_id: ids[1],
			status: "active",
			steps_json: "[]",
			reward_components_json: JSON.stringify({ environmentReward: 0 }),
			metrics_json: JSON.stringify({ episodeLength: 0, finalStatus: "active" }),
			metadata_json: "{}",
			start_time: Date.now(),
			end_time: null,
			duration_ms: null,
			total_reward: 0,
		});
	}

	private stringLiterals(text: string): string[] {
		const out: string[] = [];
		const re = /'((?:''|[^'])*)'/g;
		let match: RegExpExecArray | null = re.exec(text);
		while (match !== null) {
			out.push(match[1].replace(/''/g, "'"));
			match = re.exec(text);
		}
		return out;
	}

	private sqlStringAfter(sqlText: string, marker: string): string[] {
		const at = sqlText.indexOf(marker);
		return at === -1 ? [] : this.stringLiterals(sqlText.slice(at));
	}

	execute(rawSql: unknown): {
		rows: Array<Record<string, unknown>>;
		columns: string[];
	} {
		// The transaction path passes a Drizzle `sql.raw` object (queryChunks
		// of {value:[text]}); the direct path passes the raw string.
		// Normalize to text.
		const sqlText = sqlTextOf(rawSql);
		if (sqlText.includes("INSERT INTO trajectories")) {
			this.insertTrajectory(sqlText);
			return { rows: [], columns: [] };
		}
		if (
			sqlText.includes("UPDATE trajectories SET") &&
			sqlText.includes("steps_json =")
		) {
			const ids = this.stringLiterals(sqlText);
			const id = ids.find((value) => this.trajectories.has(value));
			if (!id) return { rows: [], columns: [] };
			const row = this.trajectories.get(id) as Record<string, unknown>;
			const assign = (column: string): unknown => {
				const match = new RegExp(
					`${column}\\s*=\\s*('(?:''|[^'])*'|\\d+|NULL|TRUE|FALSE)`,
				).exec(sqlText);
				if (!match) return undefined;
				const raw = match[1];
				if (raw === "NULL") return null;
				if (raw === "TRUE") return true;
				if (raw === "FALSE") return false;
				if (raw.startsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
				return Number(raw);
			};
			for (const column of [
				"status",
				"steps_json",
				"metrics_json",
				"metadata_json",
				"reward_components_json",
				"end_time",
				"duration_ms",
			]) {
				const value = assign(column);
				if (value !== undefined) row[column] = value;
			}
			return { rows: [], columns: [] };
		}
		if (sqlText.includes("SELECT * FROM trajectories")) {
			const ids = this.stringLiterals(sqlText);
			const id = ids.find((value) => this.trajectories.has(value));
			const row = id ? this.trajectories.get(id) : undefined;
			return {
				rows: row ? [{ ...row }] : [],
				columns: row ? Object.keys(row) : [],
			};
		}
		if (
			sqlText.includes("FROM trajectories") &&
			sqlText.includes("SELECT id FROM")
		) {
			const ids = this.stringLiterals(sqlText);
			const id = ids.find((value) => this.trajectories.has(value));
			return { rows: id ? [{ id }] : [], columns: ["id"] };
		}
		if (sqlText.includes("trajectory_step_index")) {
			if (sqlText.trimStart().startsWith("INSERT INTO trajectory_step_index")) {
				const ids = this.stringLiterals(sqlText);
				// INSERT order: step_id, trajectory_id
				this.stepIndex.set(ids[0], {
					step_id: ids[0],
					trajectory_id: ids[1],
					step_number: 0,
					is_active: false,
				});
				return { rows: [], columns: [] };
			}
			if (sqlText.includes("SET is_active = FALSE")) {
				return { rows: [], columns: [] };
			}
			if (sqlText.includes("UPDATE trajectory_step_index")) {
				return { rows: [], columns: [] };
			}
			// SELECT i.trajectory_id, i.step_number, i.is_active
			const ids = this.stringLiterals(sqlText);
			const stepId = ids.find((value) => this.stepIndex.has(value));
			const row = stepId ? this.stepIndex.get(stepId) : undefined;
			return {
				rows: row
					? [
							{
								trajectory_id: row.trajectory_id,
								step_number: row.step_number,
								is_active: row.is_active,
							},
						]
					: [],
				columns: ["trajectory_id", "step_number", "is_active"],
			};
		}
		if (
			sqlText.includes("information_schema.columns") ||
			sqlText.includes("PRAGMA table_info")
		) {
			return {
				rows: TRAJECTORY_COLUMNS.map((column) => ({
					name: column,
					column_name: column,
				})),
				columns: ["name", "column_name"],
			};
		}
		return { rows: [], columns: [] };
	}
}

interface Harness {
	db: MiniTrajectoryDb;
	adapter: InMemoryDatabaseAdapter;
	/** The full runtime adapter (cache domain + SQL executor surface). */
	runtimeAdapter: InMemoryDatabaseAdapter;
	makeService(
		runtimeAdapterOverride?: InMemoryDatabaseAdapter,
	): Promise<TrajectoriesService>;
}

async function makeHarness(): Promise<Harness> {
	const db = new MiniTrajectoryDb();
	const adapter = new InMemoryDatabaseAdapter(AGENT_ID);
	await adapter.init();
	// The runtime adapter is the real cache domain plus the SQL executor the
	// trajectory service requires (its initialize gate). Cache bytes never
	// touch this executor — only trajectories/step-index SQL does.
	const runtimeAdapter = Object.create(
		adapter,
	) as unknown as InMemoryDatabaseAdapter & {
		db: {
			execute: (sqlText: string) => unknown;
			transaction: (
				work: (tx: { execute: (sqlText: string) => unknown }) => Promise<void>,
			) => Promise<void>;
		};
	};
	runtimeAdapter.db = {
		execute: (sqlText: string) => db.execute(sqlText),
		transaction: async (work) => {
			await work({ execute: (sqlText: string) => db.execute(sqlText) });
		},
	};
	const makeService = async (
		runtimeAdapterOverride?: InMemoryDatabaseAdapter,
	): Promise<TrajectoriesService> => {
		const runtime = {
			agentId: AGENT_ID,
			adapter: runtimeAdapterOverride ?? runtimeAdapter,
			getService: () => null,
			getServicesByType: () => [],
			reportError: () => {},
		} as unknown as IAgentRuntime;
		const service = new TrajectoriesService(runtime);
		const internals = service as unknown as {
			executeRawSql: (
				sqlText: string,
			) => Promise<{ rows: Array<Record<string, unknown>>; columns: string[] }>;
		};
		internals.executeRawSql = async (sqlText: string) => db.execute(sqlText);
		await service.initialize();
		return service;
	};
	return { db, adapter, runtimeAdapter, makeService };
}

/** Drive the REAL public capture pipeline with a tool-result carrier. */
async function captureToolTrajectory(
	service: TrajectoriesService,
	contentRefs: Array<{ ref: string; start: number; end: number }>,
): Promise<string> {
	const trajectoryId = await service.startTrajectory(AGENT_ID, {
		source: "test",
	});
	const stepId = service.startStep(trajectoryId, {
		timestamp: Date.now(),
		agentBalance: 0,
		agentPoints: 0,
		agentPnL: 0,
		openPositions: 0,
	});
	for (const { ref, start, end } of contentRefs) {
		service.logSemanticStage({
			stepId,
			stage: {
				stageId: `stage-tool-file-${ref}-${start}-${end}`,
				kind: "tool",
				startedAt: Date.now(),
				endedAt: Date.now() + 1,
				latencyMs: 1,
				tool: {
					name: "FILE",
					args: { path: ref },
					// Real content carrier shape: a validated ReadView
					// (reference + slice + sliceSha256) nested in the tool
					// result's data — exactly what
					// deriveCompactionContentManifest walks to authorize
					// content references and used ranges.
					result: {
						data: {
							reference: { kind: "file", ref },
							slice: {
								range: { unit: "byte", start, end, total: end },
								hasPrevious: start > 0,
								hasMore: false,
								completeness: "complete",
								sliceSha256: sha256Hex(`${ref}:${start}:${end}`),
							},
						},
						success: true,
						durationMs: 1,
					},
				},
			},
		});
	}
	await service.endTrajectory(stepId, "completed");
	return trajectoryId;
}

describe("TrajectoriesService detail reader consumes the persisted manifest ledger", () => {
	it("writer publishes through the production pipeline; a fresh reader reloads and verifies every shard", async () => {
		const harness = await makeHarness();
		const refs = [
			{ ref: "restart-a.txt", start: 0, end: 120 },
			{ ref: "restart-b.txt", start: 10, end: 60 },
		];

		// ── Writer phase: real capture pipeline, then full teardown ──
		let trajectoryId: string;
		{
			const writer = await harness.makeService();
			trajectoryId = await captureToolTrajectory(writer, refs);
			await writer.stop();
		}

		// ── Reader phase: completely FRESH service over the durable bytes ──
		{
			const reader = await harness.makeService();
			const detail = await reader.getTrajectoryDetail(trajectoryId);
			expect(detail).not.toBeNull();
			const entries = (detail?.metadata as Record<string, unknown>)
				?.contentManifest as CompactionContentEntry[];
			expect(Array.isArray(entries)).toBe(true);
			const refsOut = entries.map((entry) => entry.reference.ref).sort();
			expect(refsOut).toEqual([...refs.map((r) => r.ref)].sort());
			// Ranges survived the publish → persist → restart-load round trip.
			const withRanges = entries.find(
				(e) => e.reference.ref === "restart-a.txt",
			);
			expect(withRanges?.rangesUsed[0]).toEqual({
				unit: "byte",
				start: 0,
				end: 120,
			});
			await reader.stop();
		}
		await harness.adapter.close();
	}, 30_000);

	it("a trajectory with no published ledger reports the honest empty manifest", async () => {
		const harness = await makeHarness();
		const writer = await harness.makeService();
		// No tool-result carriers: the publish path authorizes nothing.
		const trajectoryId = await captureToolTrajectory(writer, []);
		await writer.stop();

		const reader = await harness.makeService();
		const detail = await reader.getTrajectoryDetail(trajectoryId);
		expect(
			(detail?.metadata as Record<string, unknown>)?.contentManifest,
		).toEqual([]);
		await reader.stop();
		await harness.adapter.close();
	}, 30_000);

	it("carriers that authorized content but a failed publication surface unavailable, never a fabricated empty manifest", async () => {
		const harness = await makeHarness();
		// The writer's adapter accepts reads but every ledger write throws —
		// both the shard-row setCaches and the head compareAndSwapCache — so
		// the production publish path (best-effort by design) leaves no head
		// behind while the trajectory's own carriers DID authorize content
		// refs. The reader must not report [] for that.
		const runtimeAdapter = Object.create(
			harness.runtimeAdapter,
		) as typeof harness.runtimeAdapter & {
			setCaches: (
				entries: Array<{ key: string; value: unknown }>,
			) => Promise<boolean>;
			compareAndSwapCache: (
				key: string,
				expectedRevision: number | null,
				nextRevision: number,
				value: unknown,
			) => Promise<boolean>;
		};
		const failWrite = async (): Promise<boolean> => {
			throw new Error("simulated ledger write failure");
		};
		runtimeAdapter.setCaches = failWrite;
		runtimeAdapter.compareAndSwapCache = failWrite;
		const writer = await harness.makeService(runtimeAdapter);
		const trajectoryId = await captureToolTrajectory(writer, [
			{ ref: "unpublished.txt", start: 0, end: 80 },
		]);
		await writer.stop();

		const reader = await harness.makeService();
		const detail = await reader.getTrajectoryDetail(trajectoryId);
		expect(detail).not.toBeNull();
		expect(
			(detail?.metadata as Record<string, unknown>)?.contentManifest,
		).toEqual({ unavailable: true });
		await reader.stop();
		await harness.adapter.close();
	}, 30_000);

	it("carriers whose absence reconstruction itself fails surface unavailable, and the read never throws", async () => {
		const harness = await makeHarness();
		// Writer whose cache writes throw (no head is ever published) AND
		// whose persisted carriers make the reader-side derivation throw:
		// two ReadViews of the same ref with CONFLICTING revisions hit
		// CONTENT_MANIFEST_REVISION_CONFLICT inside
		// deriveCompactionContentManifest — the same failure the publisher
		// swallowed. The reader's absence reconstruction must degrade to
		// {unavailable:true}, never propagate the throw out of
		// getTrajectoryDetail and never report a fabricated empty manifest.
		const runtimeAdapter = Object.create(
			harness.runtimeAdapter,
		) as typeof harness.runtimeAdapter & {
			setCaches: (
				entries: Array<{ key: string; value: unknown }>,
			) => Promise<boolean>;
			compareAndSwapCache: (
				key: string,
				expectedRevision: number | null,
				nextRevision: number,
				value: unknown,
			) => Promise<boolean>;
		};
		const failWrite = async (): Promise<boolean> => {
			throw new Error("simulated ledger write failure");
		};
		runtimeAdapter.setCaches = failWrite;
		runtimeAdapter.compareAndSwapCache = failWrite;
		const writer = await harness.makeService(runtimeAdapter);

		const trajectoryId = await writer.startTrajectory(AGENT_ID, {
			source: "test",
		});
		const stepId = writer.startStep(trajectoryId, {
			timestamp: Date.now(),
			agentBalance: 0,
			agentPoints: 0,
			agentPnL: 0,
			openPositions: 0,
		});
		for (const revision of ["r1", "r2"]) {
			writer.logSemanticStage({
				stepId,
				stage: {
					stageId: `stage-conflict-${revision}`,
					kind: "tool",
					startedAt: Date.now(),
					endedAt: Date.now() + 1,
					latencyMs: 1,
					tool: {
						name: "FILE",
						args: { path: "conflicting.txt" },
						result: {
							data: {
								reference: {
									kind: "file",
									ref: "conflicting.txt",
									revision,
								},
								slice: {
									range: { unit: "byte", start: 0, end: 10, total: 10 },
									hasPrevious: false,
									hasMore: false,
									completeness: "complete",
									revision,
									sliceSha256: sha256Hex(`conflicting:${revision}`),
								},
							},
							success: true,
							durationMs: 1,
						},
					},
				},
			});
		}
		await writer.endTrajectory(stepId, "completed");
		await writer.stop();

		const reader = await harness.makeService();
		const detail = await reader.getTrajectoryDetail(trajectoryId);
		expect(detail).not.toBeNull();
		expect(
			(detail?.metadata as Record<string, unknown>)?.contentManifest,
		).toEqual({ unavailable: true });
		await reader.stop();
		await harness.adapter.close();
	}, 30_000);

	it("a damaged ledger surfaces the explicit unavailable marker, not partial data", async () => {
		const harness = await makeHarness();
		const writer = await harness.makeService();
		const trajectoryId = await captureToolTrajectory(writer, [
			{ ref: "damaged.txt", start: 0, end: 50 },
			{ ref: "damaged-2.txt", start: 0, end: 50 },
			{ ref: "damaged-3.txt", start: 0, end: 50 },
		]);
		await writer.stop();

		// Corrupt one persisted shard row behind the adapter's back —
		// integrity verification must catch it at read time. The head key is
		// deterministic (ledgerId-prefixed); read it to find the current
		// generation, then overwrite its first shard with tampered bytes.
		const ledgerId = `${AGENT_ID}:trajectory:${trajectoryId}`;
		const headKey = `content-manifest-head:${ledgerId}`;
		const head = (
			await harness.adapter.getCaches<Record<string, unknown>>([headKey])
		).get(headKey);
		expect(head).toBeDefined();
		const shardKey = `content-manifest-shard:${ledgerId}:${head?.shardGeneration}:0`;
		await harness.adapter.setCaches([
			{ key: shardKey, value: { tampered: true } },
		]);

		const reader = await harness.makeService();
		const detail = await reader.getTrajectoryDetail(trajectoryId);
		expect(detail).not.toBeNull();
		expect(
			(detail?.metadata as Record<string, unknown>)?.contentManifest,
		).toEqual({ unavailable: true });
		await reader.stop();
		await harness.adapter.close();
	}, 30_000);
});
