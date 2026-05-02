import { vi } from "vitest";

vi.mock("@elizaos/core", () => {
  class Service {
    protected runtime: unknown;

    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  }

  return {
    Service,
    annotateActiveTrajectoryStep: vi.fn(),
    getTrajectoryContext: vi.fn(() => undefined),
  };
});
