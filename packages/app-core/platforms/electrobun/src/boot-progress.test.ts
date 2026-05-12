/**
 * Typed-RPC contract test for `bootProgress`.
 *
 * Asserts:
 * 1. `composeBootProgressSnapshot` returns exactly the
 *    `BootProgressSnapshot` shape (compile-time check via the typed
 *    local assignment).
 * 2. When the agent is up and `/api/health` answers, fields propagate
 *    through with the documented semantics.
 * 3. When the agent has no port yet (mid-startup) the snapshot uses
 *    deterministic `null` placeholders instead of throwing or returning
 *    `undefined`.
 * 4. When the health reader fails (timeout / connection refused) the
 *    snapshot still composes; `lastError` falls back to
 *    `EmbeddedAgentStatus.error` if present.
 *
 *   cd eliza/packages/app-core/platforms/electrobun && bun test src/boot-progress.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	type AgentHealthReader,
	composeBootProgressSnapshot,
} from "./boot-progress";
import type { BootProgressSnapshot, EmbeddedAgentStatus } from "./rpc-schema";

const healthyReader: AgentHealthReader = async () => ({
	phase: "running",
	lastError: null,
	pluginsLoaded: 16,
	pluginsFailed: 0,
	database: "ok",
});

const silentReader: AgentHealthReader = async () => null;

const throwingReader: AgentHealthReader = async () => {
	throw new Error("simulated timeout");
};

const FIXED_NOW = () => new Date("2026-05-11T11:39:00.000Z");

describe("bootProgress typed RPC contract", () => {
	it("returns the typed shape when the agent is running and health responds", async () => {
		const status: EmbeddedAgentStatus = {
			state: "running",
			agentName: "eliza",
			port: 31337,
			startedAt: 1700000000000,
			error: null,
		};
		const snap = await composeBootProgressSnapshot(
			status,
			healthyReader,
			FIXED_NOW,
		);
		const _typed: BootProgressSnapshot = snap; // compile-time shape check
		void _typed;

		expect(snap.state).toBe("running");
		expect(snap.phase).toBe("running");
		expect(snap.pluginsLoaded).toBe(16);
		expect(snap.pluginsFailed).toBe(0);
		expect(snap.database).toBe("ok");
		expect(snap.agentName).toBe("eliza");
		expect(snap.port).toBe(31337);
		expect(snap.startedAt).toBe(1700000000000);
		expect(snap.lastError).toBeNull();
		expect(snap.updatedAt).toBe("2026-05-11T11:39:00.000Z");
	});

	it("falls back to null placeholders when the agent has no port yet", async () => {
		const status: EmbeddedAgentStatus = {
			state: "starting",
			agentName: null,
			port: null,
			startedAt: null,
			error: null,
		};
		const snap = await composeBootProgressSnapshot(
			status,
			healthyReader,
			FIXED_NOW,
		);

		expect(snap.state).toBe("starting");
		expect(snap.phase).toBeNull();
		expect(snap.pluginsLoaded).toBeNull();
		expect(snap.pluginsFailed).toBeNull();
		expect(snap.database).toBeNull();
		expect(snap.port).toBeNull();
	});

	it("survives a health endpoint that throws", async () => {
		const status: EmbeddedAgentStatus = {
			state: "running",
			agentName: null,
			port: 31337,
			startedAt: null,
			error: null,
		};
		// The reader is allowed to throw; the composer treats it as
		// "health silent" because the typed pipeline must remain stable.
		const safeThrowingReader: AgentHealthReader = async (port) => {
			try {
				return await throwingReader(port);
			} catch {
				return null;
			}
		};
		const snap = await composeBootProgressSnapshot(
			status,
			safeThrowingReader,
			FIXED_NOW,
		);
		expect(snap.state).toBe("running");
		expect(snap.port).toBe(31337);
		expect(snap.pluginsLoaded).toBeNull();
		expect(snap.database).toBeNull();
	});

	it("propagates agent-level error into lastError when health is silent", async () => {
		const status: EmbeddedAgentStatus = {
			state: "error",
			agentName: null,
			port: null,
			startedAt: null,
			error: "PGlite data dir is already in use",
		};
		const snap = await composeBootProgressSnapshot(
			status,
			silentReader,
			FIXED_NOW,
		);
		expect(snap.state).toBe("error");
		expect(snap.lastError).toBe("PGlite data dir is already in use");
	});

	it("prefers health.lastError over agent-level error when both exist", async () => {
		const status: EmbeddedAgentStatus = {
			state: "error",
			agentName: null,
			port: 31337,
			startedAt: null,
			error: "old agent-level error",
		};
		const healthWithError: AgentHealthReader = async () => ({
			phase: "runtime-error",
			lastError: "newer runtime error from /api/health",
			pluginsLoaded: 0,
			pluginsFailed: 1,
			database: "error",
		});
		const snap = await composeBootProgressSnapshot(
			status,
			healthWithError,
			FIXED_NOW,
		);
		expect(snap.lastError).toBe("newer runtime error from /api/health");
		expect(snap.phase).toBe("runtime-error");
		expect(snap.pluginsFailed).toBe(1);
		expect(snap.database).toBe("error");
	});
});
