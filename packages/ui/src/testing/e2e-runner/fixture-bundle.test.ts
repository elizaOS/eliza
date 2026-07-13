/**
 * Verifies fixture bundling and page emission against real esbuild while
 * keeping Tailwind's network-free HTML variants deterministic.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFixtureHtml,
  bundleFixture,
  writeFixturePage,
} from "./fixture-bundle";

describe("fixture bundle", () => {
  it("bundles source-mode browser fixtures through real esbuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-fixture-"));
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
    const root = await mkdtemp(join(tmpdir(), "eliza-fixture-contracts-"));
    const entry = join(root, "entry.ts");
    const sharedRouting = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../shared/src/contracts/service-routing.ts",
    );
    await writeFile(
      entry,
      `import { SERVICE_CAPABILITIES } from ${JSON.stringify(sharedRouting)}; globalThis.__fixtureCapabilities = SERVICE_CAPABILITIES;`,
    );

    const js = await bundleFixture({ entry });

    expect(js).toContain("__fixtureCapabilities");
    expect(js).toContain("llmText");
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
    const root = await mkdtemp(join(tmpdir(), "eliza-page-"));
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
