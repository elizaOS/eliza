// The one Vitest configuration of a package (AGENTS.md, "Tests"; "Building, running and testing"): `spec init` writes
// `export default project({ root: import.meta.dirname })`. The examples, which do not install these tools, keep a
// standalone copy of its defaults.
import fs from "node:fs";
import path from "node:path";
import vibelang from "vibelang-vite";
import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/node";
import type { PluginOption } from "vite";
import { testInputs, testReceipt } from "../util.ts";

export interface Project {
  /** The package directory: `import.meta.dirname` of its vitest.config.ts. */
  root: string;
  /** The tests that are not browser tests, where they are not TESTS. */
  tests?: string[];
  /** Vite plugins the tests' sources need, such as Tailwind's. */
  plugins?: PluginOption[];
}

const GENERATED = ".cache/generated/tests";
/** The package's own tests, and the mount of every story `spec stories gen` writes. They run in Node; a test that needs a DOM names it, as the mount does: `// @vitest-environment happy-dom`. */
const TESTS = ["test/**/*.test.{ts,tsx,vibe}", "generated/stories/stories.test.tsx"];
/** The tests of the `browser` project, in one headless Chromium: `vitest run --project browser`, the `test:browser` script. */
const BROWSER = ["test/**/*.browser.test.{ts,tsx,vibe}", "generated/stories/stories.browser.test.tsx"];

/** The package's tests, and those generate.ts derives from its schemas and contracts, written first (its `main`). */
export const project = ({ root, tests = TESTS, plugins = [] }: Project) =>
  defineConfig(async ({ mode }) => {
    // Only a package with something to derive from, or with tests derived before, pays for the generator.
    if (fs.existsSync(path.join(root, GENERATED)) || fs.globSync("src/**/*.{schema,contract}.{ts,vibe}", { cwd: root }).length)
      await (await import("./generate.ts")).main(root);
    const browser = fs.globSync(BROWSER, { cwd: root }).length > 0;
    const selected = mode === "nightly" ? "nightly" : "normal", receipt = testReceipt(root, selected);
    let fingerprint: string | undefined, complete = false;
    const scheduled = new Set<string>();
    const record: Reporter = {
      onInit(ctx) {
        const config = ctx.config;
        if ((mode !== "test" && mode !== "nightly") || config.project.some((name) => name !== "node" && name !== "!browser")) return;
        fs.rmSync(receipt, { force: true });
        if (config.allowOnly || config.watch || config.filters?.length || config.testNamePattern || config.related?.length || config.changed
          || config.shard || config.cliExclude?.length || config.tagsFilter?.length) return;
        fingerprint = testInputs(root, selected);
      },
      onTestRunStart(specifications) {
        complete = fingerprint !== undefined && specifications.every((specification) => specification.project.name === "node"
          && !specification.testLines && !specification.testNamePattern && !specification.testIds && !specification.testTagsFilter);
        for (const specification of specifications) scheduled.add(specification.moduleId);
      },
      onTestRunEnd(modules, errors, reason) {
        if (!complete || reason !== "passed" || errors.length || modules.length !== scheduled.size
          || modules.some((module) => !module.ok() || !scheduled.has(module.moduleId)) || fingerprint !== testInputs(root, selected)) return;
        fs.mkdirSync(path.dirname(receipt), { recursive: true });
        const temporary = `${receipt}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify({ fingerprint }));
          fs.renameSync(temporary, receipt);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
      },
    };
    return {
      root,
      plugins: [vibelang(), ...plugins],
      test: {
        reporters: ["default", record],
        allowOnly: false,
        passWithNoTests: true,
        // `vitest run` leaves Chromium to `test:browser`, whose `--project browser` takes the place of this filter.
        project: ["!browser"],
        // A failure repeats: fixed order, no retry that could hide a flaky test. Properties use profile.ts.
        sequence: { shuffle: false, seed: 1 },
        retry: 0,
        // A journey fails by its assertions, not by the clock: it starts real servers and databases, and the first
        // import of Effect alone can take longer than Vitest's 5 s on a busy machine.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        projects: [
          { extends: true, test: { name: "node", include: [...tests, `${GENERATED}/**/*.test.ts`], exclude: ["**/node_modules/**", ...BROWSER], environment: "node" } },
          // Chromium, and the provider that drives it, only where there are browser tests.
          ...browser ? [{
            extends: true,
            test: {
              name: "browser",
              include: BROWSER,
              // One page at a time in the one browser, so a journey never sees another file's storage or focus.
              fileParallelism: false,
              browser: {
                enabled: true, provider: (await import("@vitest/browser-playwright")).playwright(), headless: true,
                instances: [{ browser: "chromium" as const }], screenshotFailures: true, trace: "retain-on-failure" as const,
              },
            },
          }] : [],
        ],
      },
    };
  });
