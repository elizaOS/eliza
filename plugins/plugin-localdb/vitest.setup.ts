/** Vitest setup: stubs `@elizaos/core`'s `logger` with no-op mocks so tests don't emit real log output, keeping the rest of the module's exports real. */
import { vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});
