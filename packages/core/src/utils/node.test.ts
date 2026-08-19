/**
 * Deterministic tests for local-server URL construction and Node utility exports.
 * Environment cleanup is limited to the server-port key owned by this suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvironment } from "./environment.js";
import { getLocalServerUrl, pingServer, waitForServerReady } from "./node.js";

describe("node utilities", () => {
	const originalServerPort = process.env.SERVER_PORT;
	const originalElizaApiPort = process.env.ELIZA_API_PORT;
	const originalElizaPort = process.env.ELIZA_PORT;

	beforeEach(() => {
		getEnvironment().clearCache();
		delete process.env.SERVER_PORT;
		delete process.env.ELIZA_API_PORT;
		delete process.env.ELIZA_PORT;
	});

	afterEach(() => {
		getEnvironment().clearCache();
		if (originalServerPort === undefined) delete process.env.SERVER_PORT;
		else process.env.SERVER_PORT = originalServerPort;
		if (originalElizaApiPort === undefined) delete process.env.ELIZA_API_PORT;
		else process.env.ELIZA_API_PORT = originalElizaApiPort;
		if (originalElizaPort === undefined) delete process.env.ELIZA_PORT;
		else process.env.ELIZA_PORT = originalElizaPort;
	});

	describe("getLocalServerUrl", () => {
		it("formats URL with leading slash by default", () => {
			expect(getLocalServerUrl("/api/agents")).toBe(
				"http://localhost:3000/api/agents",
			);
		});

		it("normalizes path missing leading slash", () => {
			expect(getLocalServerUrl("api/health")).toBe(
				"http://localhost:3000/api/health",
			);
			expect(getLocalServerUrl("status")).toBe("http://localhost:3000/status");
		});

		it("preserves an explicitly empty path", () => {
			expect(getLocalServerUrl("")).toBe("http://localhost:3000");
		});

		it("respects SERVER_PORT environment variable", () => {
			process.env.SERVER_PORT = "4567";
			getEnvironment().clearCache();

			expect(getLocalServerUrl("/ready")).toBe("http://localhost:4567/ready");
		});

		it("prefers the browser runtime API port aliases", () => {
			process.env.SERVER_PORT = "3001";
			process.env.ELIZA_PORT = "32336";
			process.env.ELIZA_API_PORT = "32337";
			getEnvironment().clearCache();

			expect(getLocalServerUrl("/api/media/example.txt")).toBe(
				"http://localhost:32337/api/media/example.txt",
			);
		});
	});

	describe("re-exports", () => {
		it("re-exports server health functions", () => {
			expect(typeof pingServer).toBe("function");
			expect(typeof waitForServerReady).toBe("function");
		});
	});
});
