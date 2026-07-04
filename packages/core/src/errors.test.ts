/**
 * Contract tests for structured runtime errors and the first diagnostic
 * reporting primitive used by the fallback-slop cleanup batches.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "./errors";
import { AgentRuntime } from "./runtime";
import { EventType } from "./types/events";

describe("ElizaError", () => {
	it("preserves code, context, severity, and cause", () => {
		const cause = new Error("database closed");
		const error = new ElizaError("DB_COUNT_UNAVAILABLE", "count failed", {
			context: { table: "agents" },
			cause,
			severity: "fatal",
		});

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ElizaError");
		expect(error.message).toBe("count failed");
		expect(error.code).toBe("DB_COUNT_UNAVAILABLE");
		expect(error.context).toEqual({ table: "agents" });
		expect(error.severity).toBe("fatal");
		expect(error.cause).toBe(cause);
	});

	it("supports option-object construction", () => {
		const error = new ElizaError("config corrupt", {
			code: "PROJECT_METADATA_CORRUPT",
			context: { file: ".elizaos/template.json" },
		});

		expect(error.code).toBe("PROJECT_METADATA_CORRUPT");
		expect(error.message).toBe("config corrupt");
		expect(error.context).toEqual({ file: ".elizaos/template.json" });
	});
});

describe("AgentRuntime.reportError", () => {
	it("emits a typed ERROR_REPORTED payload for structured errors", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		const received: Array<{
			scope: string;
			code: string;
			message: string;
			context?: Record<string, unknown>;
			severity?: string;
		}> = [];

		runtime.registerEvent(EventType.ERROR_REPORTED, async (payload) => {
			received.push({
				scope: payload.scope,
				code: payload.code,
				message: payload.message,
				context: payload.context,
				severity: payload.severity,
			});
		});

		await runtime.reportError(
			"DatabaseRows.count",
			new ElizaError("DB_COUNT_UNAVAILABLE", "count failed", {
				context: { table: "agents" },
				severity: "fatal",
			}),
			{ query: "select count(*)" },
		);

		expect(received).toEqual([
			{
				scope: "DatabaseRows.count",
				code: "DB_COUNT_UNAVAILABLE",
				message: "count failed",
				context: { table: "agents", query: "select count(*)" },
				severity: "fatal",
			},
		]);
	});

	it("never throws when ERROR_REPORTED handlers fail", async () => {
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		runtime.registerEvent(EventType.ERROR_REPORTED, async () => {
			throw new Error("listener failed");
		});

		await expect(
			runtime.reportError("Diagnostics.test", new Error("boom")),
		).resolves.toBeUndefined();
	});
});
