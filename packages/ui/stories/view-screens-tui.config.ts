/**
 * Vitest config for the TUI screenshot generator. Reuses the package vitest
 * config's resolve aliases + react dedupe (so the workspace imports resolve)
 * but runs ONLY the screenshot generator, which lives outside the default test
 * globs. `include` is replaced (not merged) so the full suite doesn't run.
 */
import base from "../vitest.config.ts";

const config = {
  ...base,
  test: {
    ...base.test,
    include: ["stories/view-screens-tui.gen.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
  },
};

export default config;
