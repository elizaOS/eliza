/**
 * Real-PGLite coverage for the #13775 DB join key: the `trace_id` column is
 * self-migrated onto a legacy `trajectories` table, an insert carries the
 * correlation envelope, and the list surface filters by `traceId`. Drives the
 * service against a real drizzle/PGLite `db.execute` (not a stubbed executor),
 * so the DDL, ALTER-TABLE self-migration, and SQL WHERE run for real.
 */

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, MessagePayload } from "../../types";
import { trajectoriesPlugin } from "./index";
import { TrajectoriesService } from "./TrajectoriesService";

let db: ReturnType<typeof drizzle>;
let client: PGlite;
let service: TrajectoriesService;

async function raw(text: string): Promise<Record<string, unknown>[]> {
	const res = await db.execute(sql.raw(text));
	return (res.rows as Record<string, unknown>[]) ?? [];
}

async function traceColumnExists(): Promise<boolean> {
	const rows = await raw(
		`SELECT column_name FROM information_schema.columns
     WHERE table_name = 'trajectories' AND column_name = 'trace_id'`,
	);
	return rows.some((r) => r.column_name === "trace_id");
}

beforeAll(async () => {
	client = new PGlite();
	db = drizzle(client);
	const runtime = {
		agentId: "00000000-0000-4000-8000-000000000001",
		adapter: { db },
		getService: () => null,
		getServicesByType: () => [],
	} as unknown as IAgentRuntime;
	service = new TrajectoriesService(runtime);
	// NODE_ENV=test defaults the gate off; enable persistence directly for this
	// DB-round-trip test.
	service.setEnabled(true);
	await service.initialize();
}, 60_000);

afterAll(async () => {
	await client?.close?.();
});

describe("trajectories trace_id join key (real PGLite)", () => {
	it("self-migrates trace_id onto a legacy trajectories table", async () => {
		expect(await traceColumnExists()).toBe(true);

		// Simulate a legacy deployment predating the column, then re-run the
		// idempotent schema bootstrap; ensureTrajectoryColumnsExist must re-add it.
		await raw(`ALTER TABLE trajectories DROP COLUMN trace_id`);
		expect(await traceColumnExists()).toBe(false);

		const svc = service as unknown as {
			initialized: boolean;
			initialize: () => Promise<void>;
		};
		svc.initialized = false;
		await svc.initialize();
		expect(await traceColumnExists()).toBe(true);
	});

	it("persists + filters by traceId with the correlation envelope in metadata", async () => {
		const logger = service as unknown as {
			startTrajectory: (
				agentId: string,
				opts: {
					source?: string;
					traceId?: string;
					scenarioId?: string;
					metadata?: Record<string, unknown>;
				},
			) => Promise<string>;
			listTrajectories: (opts: {
				limit?: number;
				traceId?: string;
			}) => Promise<{
				trajectories: Array<{
					id: string;
					metadata: Record<string, unknown>;
				}>;
				total: number;
			}>;
		};
		const traceId = "trace-fixture-0001";

		const id = await logger.startTrajectory(
			"00000000-0000-4000-8000-000000000001",
			{
				source: "chat",
				traceId,
				scenarioId: "run-xyz",
				metadata: { roomId: "room-1" },
			},
		);
		expect(typeof id).toBe("string");

		// A second trajectory under a different trace must NOT match the filter.
		await logger.startTrajectory("00000000-0000-4000-8000-000000000001", {
			source: "chat",
			traceId: "trace-fixture-0002",
		});

		const filtered = await logger.listTrajectories({ traceId, limit: 50 });
		expect(filtered.trajectories.map((t) => t.id)).toEqual([id]);

		const correlation = (
			filtered.trajectories[0].metadata as {
				correlation?: { traceId?: string; runId?: string };
			}
		).correlation;
		expect(correlation?.traceId).toBe(traceId);
		expect(correlation?.runId).toBe("run-xyz");

		const rows = await raw(
			`SELECT trace_id FROM trajectories WHERE id = '${id}'`,
		);
		expect(rows[0]?.trace_id).toBe(traceId);
	});

	// Emit-first paths (the agent API chat route and connectors) emit
	// MESSAGE_RECEIVED before messageService.handleMessage mints the turn's
	// traceId, so the plugin handler is the first touchpoint and must mint +
	// stamp the id itself or the DB row persists trace_id NULL and never joins
	// the file trajectory (#13871 audit).
	it("mints and persists a traceId when MESSAGE_RECEIVED arrives before message.ts stamps one", async () => {
		const handler = trajectoriesPlugin.events?.MESSAGE_RECEIVED?.[0];
		expect(typeof handler).toBe("function");

		const runtime = {
			agentId: "00000000-0000-4000-8000-000000000001",
			adapter: { db },
			getService: () => service,
			getServicesByType: () => [service],
			logger: {
				debug() {},
				info() {},
				warn(...args: unknown[]) {
					// The handler swallows failures via logger.warn; surface them so a
					// broken insert cannot pass as green.
					throw new Error(`trajectory handler warned: ${JSON.stringify(args)}`);
				},
				error() {},
			},
		} as unknown as IAgentRuntime;

		const message = {
			id: "10000000-0000-4000-8000-00000000aaaa",
			roomId: "20000000-0000-4000-8000-00000000bbbb",
			entityId: "30000000-0000-4000-8000-00000000cccc",
			content: { text: "hello", source: "api" },
			// No metadata: mirrors chat-routes.ts emitting before any stamp exists.
		} as unknown as Memory;

		await handler?.({ runtime, message, source: "api" } as MessagePayload);

		const meta = message.metadata as {
			traceId?: string;
			trajectoryId?: string;
		};
		expect(typeof meta.traceId).toBe("string");
		expect((meta.traceId ?? "").length).toBeGreaterThan(0);
		expect(typeof meta.trajectoryId).toBe("string");

		const rows = await raw(
			`SELECT trace_id, metadata_json FROM trajectories WHERE id = '${meta.trajectoryId}'`,
		);
		expect(rows.length).toBe(1);
		expect(rows[0]?.trace_id).toBe(meta.traceId);
	});
});
