/**
 * Verifies fixture bundling and page emission against real esbuild while
 * keeping Tailwind's network-free HTML variants deterministic.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { stubElizaCore, stubNodeBuiltins } from "./esbuild-stubs";
import {
  buildFixtureHtml,
  bundleFixture,
  writeFixturePage,
} from "./fixture-bundle";

const fixtureRoots: string[] = [];
async function makeFixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("fixture bundle", () => {
  it("core fixtures support declared exports and reject unconfigured calls", async () => {
    const root = await makeFixtureRoot("eliza-core-fixture-");
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      'import core from "@elizaos/core"; globalThis.fixture = { visible: () => core.isViewVisible(), unexpected: () => core.unconfiguredOperation() };',
    );
    const js = await bundleFixture({ entry, plugins: [stubElizaCore()] });
    const context: {
      fixture?: { visible: () => boolean; unexpected: () => unknown };
    } = {};
    runInNewContext(js, context);
    expect(context.fixture?.visible()).toBe(true);
    expect(() => context.fixture?.unexpected()).toThrow(
      "Unconfigured core fixture export: unconfiguredOperation",
    );
  });

  it("Node fixtures report unavailable files and reject accidental filesystem or crypto work", async () => {
    const root = await makeFixtureRoot("eliza-node-fixture-");
    const entry = join(root, "entry.ts");
    await writeFile(
      entry,
      'import { existsSync, readFileSync } from "node:fs"; import { createHash } from "node:crypto"; globalThis.fixture = { exists: () => existsSync("missing"), read: () => readFileSync("missing"), hash: () => createHash("sha256") };',
    );
    const js = await bundleFixture({ entry, plugins: [stubNodeBuiltins()] });
    const context: {
      fixture?: {
        exists: () => boolean;
        read: () => unknown;
        hash: () => unknown;
      };
    } = {};
    runInNewContext(js, context);
    expect(context.fixture?.exists()).toBe(false);
    expect(() => context.fixture?.read()).toThrow(
      "Node-only operation executed in browser fixture",
    );
    expect(() => context.fixture?.hash()).toThrow(
      "Node-only operation executed in browser fixture",
    );
  });

  it("bundles source-mode browser fixtures through real esbuild", async () => {
    const root = await makeFixtureRoot("eliza-fixture-");
    const entry = join(root, "entry.ts");
    await writeFile(entry, "globalThis.__fixtureValue = 'ready';");
    const observedConditions: string[][] = [];

    const js = await bundleFixture({
      entry,
      plugins: [
        {
          name: "observe-conditions",
          setup(build) {
            observedConditions.push([
              ...(build.initialOptions.conditions ?? []),
            ]);
          },
        },
      ],
    });

    expect(observedConditions).toEqual([["eliza-source", "browser"]]);
    expect(js).toContain("__fixtureValue");
    expect(js).toContain("ready");
  });

  it("bundles shared routing contracts before workspace dist exists", async () => {
    const root = await makeFixtureRoot("eliza-fixture-contracts-");
    const entry = join(root, "entry.ts");
    const sharedRouting = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../core/src/contracts/service-routing.ts",
    );
    await writeFile(
      entry,
      `import { SERVICE_CAPABILITIES } from ${JSON.stringify(sharedRouting)}; globalThis.__fixtureCapabilities = SERVICE_CAPABILITIES;`,
    );

    const js = await bundleFixture({ entry });

    expect(js).toContain("__fixtureCapabilities");
    expect(js).toContain("llmText");
  });

  it("ignores incidental CSS imports in the inline JavaScript fixture", async () => {
    const root = await makeFixtureRoot("eliza-fixture-css-");
    const entry = join(root, "entry.ts");
    const styles = join(root, "package-styles.css");
    await writeFile(styles, ".package-only { color: rebeccapurple; }");
    await writeFile(
      entry,
      'import "./package-styles.css"; globalThis.__fixtureCss = "ignored";',
    );

    const js = await bundleFixture({ entry });

    expect(js).toContain("__fixtureCss");
    expect(js).not.toContain("rebeccapurple");
  });

  it("renders each styling mode and optional browser bootstrap", () => {
    const cdn = buildFixtureHtml({
      js: "window.started=true",
      title: "Fixture",
      processShim: true,
      htmlClass: "dark",
      headHtml: '<meta name="fixture" content="yes">',
      background: "#16121c",
    });
    expect(cdn).toContain('<html class="dark">');
    expect(cdn).toContain("cdn.tailwindcss.com");
    expect(cdn).toContain("window.process=");
    expect(cdn).toContain("/api/runtime/mode");
    expect(cdn).toContain('deploymentRuntime:"local"');
    expect(cdn).toContain("background:#16121c");

    const compiled = buildFixtureHtml({
      js: "",
      title: "Compiled",
      tailwind: { css: ".brand{color:#ff6b35}" },
    });
    expect(compiled).toContain("<style>.brand{color:#ff6b35}</style>");
    expect(compiled).not.toContain("cdn.tailwindcss.com");

    const bare = buildFixtureHtml({ js: "", title: "Bare", tailwind: "none" });
    expect(bare).not.toContain("<style></style>");
  });

  it("writes a loadable file URL containing the bundled fixture", async () => {
    const root = await makeFixtureRoot("eliza-page-");
    const entry = join(root, "entry.ts");
    await writeFile(entry, "document.body.dataset.fixture = 'written';");

    const url = await writeFixturePage({
      entry,
      outDir: root,
      htmlName: "fixture.html",
      title: "Written fixture",
      tailwind: "none",
    });

    expect(url).toBe(`file://${join(root, "fixture.html")}`);
    await expect(
      readFile(join(root, "fixture.html"), "utf8"),
    ).resolves.toContain("written");
  });
});
