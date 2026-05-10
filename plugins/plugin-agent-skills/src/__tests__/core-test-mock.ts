import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
	const logger = {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		log: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
	};

	return {
		annotateActiveTrajectoryStep: vi.fn(),
		getTrajectoryContext: vi.fn(() => undefined),
		logger,
	};
});
