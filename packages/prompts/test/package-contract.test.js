/**
 * Exercises workspace and published package consumption with real runtimes.
 * The integration harness packs and installs the compiled tarball outside the
 * workspace so aliases cannot hide missing files or invalid specifiers.
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replyTemplate } from "../src/index.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publishRoot = join(packageRoot, "dist");
describe("package consumer contract", () => {
  it("executes through Bun workspace package resolution", async () => {
    const published = await import("@elizaos/prompts");
    const authored = await import("../src/index.ts");
    assert.strictEqual(published.replyTemplate, authored.replyTemplate);
  });

  it("keeps native Node conditions on executable dist", () => {
    const resolveProbe =
      'process.stdout.write(import.meta.resolve("@elizaos/prompts"));';
    const normalResolution = execFileSync(
      "node",
      ["--input-type=module", "--eval", resolveProbe],
      { cwd: packageRoot, encoding: "utf8" },
    );
    const moduleResolution = execFileSync(
      "node",
      ["--conditions=module", "--input-type=module", "--eval", resolveProbe],
      { cwd: packageRoot, encoding: "utf8" },
    );
    const developmentResolution = execFileSync(
      "node",
      [
        "--conditions=development",
        "--input-type=module",
        "--eval",
        resolveProbe,
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );
    const productionResolution = execFileSync(
      "node",
      [
        "--conditions=production",
        "--input-type=module",
        "--eval",
        resolveProbe,
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );

    assert.strictEqual(
      normalResolution,
      pathToFileURL(join(publishRoot, "index.js")).href,
    );
    assert.strictEqual(moduleResolution, normalResolution);
    assert.strictEqual(developmentResolution, normalResolution);
    assert.strictEqual(productionResolution, normalResolution);

    const runtimeProbe = [
      'const { replyTemplate } = await import("@elizaos/prompts");',
      "process.stdout.write(replyTemplate);",
    ].join("\n");
    for (const args of [
      [],
      ["--conditions=development"],
      ["--conditions=production"],
    ]) {
      assert.strictEqual(
        execFileSync(
          "node",
          [...args, "--input-type=module", "--eval", runtimeProbe],
          { cwd: packageRoot, encoding: "utf8" },
        ),
        replyTemplate,
      );
    }
  });

  it("loads the packed build in an isolated native Node consumer", {
    timeout: 60_000,
  }, async () => {
    const workspacePrompts = await import("@elizaos/prompts");
    const sandbox = mkdtempSync(join(tmpdir(), "eliza-prompts-consumer-"));
    const packDir = join(sandbox, "pack");
    const consumerDir = join(sandbox, "consumer");
    try {
      mkdirSync(packDir);
      mkdirSync(consumerDir);
      const packOutput = execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
        { cwd: publishRoot, encoding: "utf8" },
      );
      const [packRecord] = JSON.parse(packOutput);
      assert.ok(packRecord?.filename, "npm pack should report its tarball");
      const packedPaths = new Set(packRecord.files.map(({ path }) => path));
      assert.ok(packedPaths.has("index.js"));
      assert.ok(packedPaths.has("index.d.ts"));
      assert.strictEqual(
        [...packedPaths].some((path) => path.startsWith("src/")),
        false,
        "the release tarball must not publish TypeScript source as runtime code",
      );

      const [commonPack] = JSON.parse(
        execFileSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
          {
            cwd: join(packageRoot, "../common/dist"),
            encoding: "utf8",
          },
        ),
      );
      writeFileSync(
        join(sandbox, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      execFileSync(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          join(packDir, basename(packRecord.filename)),
          join(packDir, basename(commonPack.filename)),
        ],
        { cwd: sandbox, stdio: "pipe" },
      );
      const installedManifest = JSON.parse(
        readFileSync(
          join(sandbox, "node_modules/@elizaos/prompts/package.json"),
          "utf8",
        ),
      );
      assert.strictEqual(installedManifest.types, "./index.d.ts");
      assert.strictEqual(installedManifest.exports["."].types, "./index.d.ts");
      assert.strictEqual(
        installedManifest.exports["."]["eliza-source"],
        "./index.js",
      );

      const probe = join(consumerDir, "probe.mjs");
      writeFileSync(
        probe,
        [
          'import { replyTemplate } from "@elizaos/prompts";',
          'import { textIncludesKeywordTerm } from "@elizaos/prompts/keyword-matching";',
          'import { parseJSONObjectFromText } from "@elizaos/prompts/parsing";',
          'import { composePrompt } from "@elizaos/prompts/rendering";',
          'if (composePrompt({ state: { value: "<tag>\\n{{other}}" }, template: "{{value}}" }) !== "<tag>\\n{{other}}") process.exit(73);',
          'if (parseJSONObjectFromText("{answer:42,}")?.answer !== 42 || parseJSONObjectFromText("[1]") !== null) process.exit(72);',
          'if (!textIncludesKeywordTerm("open calendar", "calendar") || textIncludesKeywordTerm("category", "cat")) process.exit(71);',
          'if (process.release.name !== "node") process.exit(70);',
          'const resolved = import.meta.resolve("@elizaos/prompts");',
          "process.stdout.write(JSON.stringify({ replyTemplate, resolved }));",
        ].join("\n"),
      );

      const runProbe = (args) =>
        JSON.parse(
          execFileSync("node", [...args, probe], {
            cwd: consumerDir,
            encoding: "utf8",
          }),
        );
      const expectedResolution = realpathSync(
        join(sandbox, "node_modules/@elizaos/prompts/index.js"),
      );
      const normalResult = runProbe([]);
      const moduleResult = runProbe(["--conditions=module"]);
      const sourceConditionResult = runProbe(["--conditions=eliza-source"]);
      for (const result of [
        normalResult,
        moduleResult,
        sourceConditionResult,
      ]) {
        assert.strictEqual(
          result.replyTemplate,
          workspacePrompts.replyTemplate,
        );
        assert.strictEqual(fileURLToPath(result.resolved), expectedResolution);
      }
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
