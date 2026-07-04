/**
 * Vitest setup file that stubs the @elizaos/core logger so registry and plugin
 * suites can assert on log calls without pulling in the full core module.
 */

import { vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	},
}));
