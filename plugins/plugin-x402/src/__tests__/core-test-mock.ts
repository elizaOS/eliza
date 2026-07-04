/** Shared `@elizaos/core` mock (logger only) imported by this package's vitest suites. */
import { vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
