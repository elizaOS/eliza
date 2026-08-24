/**
 * Unit tests for agent runtime shim: validates telemetry span stubs
 * and default workspace directory resolution.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createIntegrationTelemetrySpan,
	resolveDefaultAgentWorkspaceDir,
} from "./agent-runtime-shim.ts";

describe("agent-runtime-shim", () => {
	it("creates inert integration telemetry span", () => {
		const span = createIntegrationTelemetrySpan({
			boundary: "cloud",
			operation: "sync",
		});
		expect(span).toBeDefined();
		expect(() => span.success()).not.toThrow();
		expect(() => span.failure()).not.toThrow();
	});

	it("resolves workspace directory from ELIZA_WORKSPACE_DIR env", () => {
		const fakeEnv = { ELIZA_WORKSPACE_DIR: "/custom/workspace" };
		const dir = resolveDefaultAgentWorkspaceDir(fakeEnv, () => "/home/user", () => "/cwd");
		expect(dir).toBe(path.resolve("/custom/workspace"));
	});

	it("resolves default state workspace directory with profile", () => {
		const fakeEnv = {
			ELIZA_STATE_DIR: "/state/dir",
			ELIZA_PROFILE: "custom-profile",
		};
		const dir = resolveDefaultAgentWorkspaceDir(fakeEnv, () => "/home/user", () => "/cwd");
		expect(dir).toBe(path.resolve("/state/dir/workspace-custom-profile"));
	});
});
