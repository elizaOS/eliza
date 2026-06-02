import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// app-model-tester does not declare `react` directly; resolve it from the
// workspace UI package (which does) so the bare `react` import in
// model-tester-app.ts loads at test time without a per-package dependency.
const requireFromUi = createRequire(
  path.resolve(__dirname, "../../packages/ui/package.json"),
);
const reactEntry = requireFromUi.resolve("react");

export default defineConfig({
  resolve: {
    alias: [{ find: /^react$/, replacement: reactEntry }],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
