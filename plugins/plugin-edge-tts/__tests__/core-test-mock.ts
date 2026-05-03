import { vi } from "vitest";

vi.mock("@elizaos/core", () => ({
	ModelType: {
		TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
	},
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	},
}));
