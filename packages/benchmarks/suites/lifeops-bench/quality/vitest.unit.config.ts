// Unit lane: the pure benchmark pieces (metrics, oracle, corpus invariants,
// mock-model prompt parsing). No runtime, no DB, no aliases — every import in
// these files is either local or type-only.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["triage/**/*.test.ts", "timeliness/**/*.test.ts"],
    exclude: ["**/*.gate.test.ts", "**/node_modules/**", "dist/**"],
    environment: "node",
  },
});
