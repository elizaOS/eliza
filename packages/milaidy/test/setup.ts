import { afterAll, afterEach, vi } from "vitest";

// Ensure Vitest environment is properly set
process.env.VITEST = "true";

import { withIsolatedTestHome } from "./test-env";

const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());

afterEach(() => {
  // Guard against leaked fake timers across test files/workers.
  vi.useRealTimers();
});
