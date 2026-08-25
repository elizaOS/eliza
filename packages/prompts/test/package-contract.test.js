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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "../..");
const publishRoot = join(packageRoot, "dist");
describe("package consumer contract", () => {
  it("executes through Bun workspace package resolution", async () => {
    const { compressPromptDescription } = await import("@elizaos/prompts");
    const payload = "  Bun keeps this complete.\nAnd this line too.  ";
    assert.strictEqual(compressPromptDescription(payload), payload);
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
      assert.ok(packedPaths.has("prompt-compression.js"));
      assert.ok(packedPaths.has("prompt-compression.d.ts"));
      assert.strictEqual(
        [...packedPaths].some((path) => path.startsWith("src/")),
        false,
        "the release tarball must not publish TypeScript source as runtime code",
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

      const probe = join(consumerDir, "probe.mjs");
      const payload =
        "  Preserve every line.\n\n" +
        "A URL: https://example.com/items?cursor=next\n" +
        "A code fence: ```ts\nconst complete = true;\n```  ";
      writeFileSync(
        probe,
        [
          'import { compressPromptDescription } from "@elizaos/prompts";',
          'import { replyTemplate } from "@elizaos/prompts";',
          'if (process.release.name !== "node") process.exit(70);',
          "const value = process.env.ELIZA_PROMPTS_PROBE;",
          "if (compressPromptDescription(value) !== value) process.exit(71);",
          "process.stdout.write(JSON.stringify({ replyTemplate, value }));",
        ].join("\n"),
      );

      const probeOutput = execFileSync("node", [probe], {
        cwd: consumerDir,
        encoding: "utf8",
        env: { ...process.env, ELIZA_PROMPTS_PROBE: payload },
      });
      const result = JSON.parse(probeOutput);
      assert.strictEqual(result.value, payload);
      assert.strictEqual(result.replyTemplate, workspacePrompts.replyTemplate);
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("resolves core prompt declarations without a prebuilt prompts dist", {
    timeout: 60_000,
  }, () => {
    const sandbox = mkdtempSync(join(tmpdir(), "eliza-prompts-declarations-"));
    try {
      rmSync(join(packageRoot, "dist"), { force: true, recursive: true });
      execFileSync(
        join(repositoryRoot, "node_modules/.bin/tsc6"),
        [
          "--ignoreConfig",
          "--target",
          "ES2022",
          "--module",
          "ESNext",
          "--moduleResolution",
          "Bundler",
          "--declaration",
          "--emitDeclarationOnly",
          "--skipLibCheck",
          "--rootDir",
          join(repositoryRoot, "packages/core/src"),
          "--outDir",
          sandbox,
          join(repositoryRoot, "packages/core/src/prompts.ts"),
          join(repositoryRoot, "packages/core/src/utils/prompt-compression.ts"),
        ],
        { cwd: repositoryRoot, stdio: "pipe" },
      );
      assert.ok(
        readFileSync(join(sandbox, "prompts.d.ts")).length > 0,
        "the production core prompt declaration should emit from a clean prompts package",
      );
    } finally {
      execFileSync("bun", ["run", "build:package"], {
        cwd: packageRoot,
        stdio: "pipe",
      });
      rmSync(sandbox, { force: true, recursive: true });
    }
  });
});
