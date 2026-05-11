/**
 * Tests for the RPC port resolver — the fix that lets typed-RPC
 * handlers actually serve requests in dev-desktop mode.
 *
 * Pre-fix behavior: `agent.getStatus().port` was the only source. In
 * dev-desktop topology the agent runs in a separate dev-server.ts
 * child, so the electrobun bun process's AgentManager status stayed at
 * port=null forever. Every typed-RPC call threw AgentNotReadyError,
 * forcing the renderer to always fall back to HTTP. Beat the purpose of
 * having RPC at all in dev mode.
 *
 * Post-fix: when the embedded port is null, the resolver falls back to
 * `ELIZA_API_PORT` (the orchestrator-exported env var). The handler can
 * then actually contact the externally-managed agent.
 */

import { describe, expect, it } from "bun:test";
import { resolveRpcAgentPort } from "./rpc-port-resolver";

describe("resolveRpcAgentPort", () => {
	it("returns the embedded port when present (canonical path)", () => {
		expect(resolveRpcAgentPort(54321, { ELIZA_API_PORT: "31337" })).toBe(54321);
	});

	it("falls back to ELIZA_API_PORT when embedded port is null (dev-desktop case)", () => {
		expect(resolveRpcAgentPort(null, { ELIZA_API_PORT: "31337" })).toBe(31337);
	});

	it("falls back to ELIZA_PORT as a secondary env source", () => {
		expect(resolveRpcAgentPort(null, { ELIZA_PORT: "42424" })).toBe(42424);
	});

	it("returns the desktop default when no env override is provided", () => {
		// `resolveDesktopApiPort` returns DEFAULT_DESKTOP_API_PORT (31337)
		// when no env override is set. The composer's reader will then hit
		// HTTP and surface a real transport error if the agent isn't there.
		const port = resolveRpcAgentPort(null, {});
		expect(port).toBeGreaterThan(0);
	});

	it("rejects non-positive embedded ports and falls back", () => {
		expect(resolveRpcAgentPort(0, { ELIZA_API_PORT: "31337" })).toBe(31337);
		expect(resolveRpcAgentPort(-1, { ELIZA_API_PORT: "31337" })).toBe(31337);
	});
});
