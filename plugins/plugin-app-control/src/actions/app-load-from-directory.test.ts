/**
 * Unit tests for app-load-from-directory action and package.json discovery.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runLoadFromDirectory } from "./app-load-from-directory.js";

describe("app-load-from-directory discovery", () => {
	it("skips subdirectories with malformed package.json without throwing SyntaxError", async () => {
		const tempDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "eliza-app-load-test-"),
		);
		try {
			const malformedAppDir = path.join(tempDir, "invalid-app");
			await fs.mkdir(malformedAppDir, { recursive: true });
			await fs.writeFile(
				path.join(malformedAppDir, "package.json"),
				"{ invalid json with trailing comma, }",
				"utf8",
			);

			const validAppDir = path.join(tempDir, "valid-app");
			await fs.mkdir(validAppDir, { recursive: true });
			await fs.writeFile(
				path.join(validAppDir, "package.json"),
				JSON.stringify({
					name: "valid-test-app",
					elizaos: {
						app: {
							permissions: {
								promptInjection: "sandbox",
							},
						},
					},
				}),
				"utf8",
			);

			const mockRegistry = {
				register: () => {},
			};

			const mockRuntime = {
				getService: () => mockRegistry,
			};

			const result = await runLoadFromDirectory({
				runtime: mockRuntime as never,
				message: {} as never,
				state: {} as never,
				options: { directory: tempDir },
				repoRoot: tempDir,
			});

			expect(result.success).toBe(true);
			expect(result.values?.registeredCount).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
