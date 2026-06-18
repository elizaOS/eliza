import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// app-model-tester does not declare `react` / `react-dom` directly; resolve them
// from the workspace UI package (which does) so the bare `react` import in
// model-tester-app.ts and the jsdom view tests load at test time without a
// per-package dependency.
const requireFromUi = createRequire(
  path.resolve(__dirname, "../../packages/ui/package.json"),
);
const reactEntry = requireFromUi.resolve("react");
const reactJsxRuntime = requireFromUi.resolve("react/jsx-runtime");
const reactDomEntry = requireFromUi.resolve("react-dom");
const reactDomClient = requireFromUi.resolve("react-dom/client");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactEntry },
      { find: /^react\/jsx-runtime$/, replacement: reactJsxRuntime },
      { find: /^react-dom$/, replacement: reactDomEntry },
      { find: /^react-dom\/client$/, replacement: reactDomClient },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
