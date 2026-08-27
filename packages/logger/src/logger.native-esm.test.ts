/**
 * Exercises the logger through real native-ESM Node subprocesses so Vitest's
 * module transform cannot supply CommonJS globals. The source run asserts its
 * TypeScript loader preserves that boundary; a built package is also checked
 * through plain Node when `dist` is present.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function verifyNativeEsmTarget({
  name,
  url,
  loaderArgs = [],
}: {
  name: string;
  url: string;
  loaderArgs?: string[];
}): void {
  const directory = mkdtempSync(join(tmpdir(), "eliza-logger-native-esm-"));
  temporaryDirectories.push(directory);

  const outputMarker = `native-esm-${name}-output`;
  const promptMarker = `native-esm-${name}-prompt`;
  const chatMarker = `native-esm-${name}-chat`;
  const successMarker = `native-esm-${name}-ok`;
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const outputPath = join(directory, "output.log");
  const childScript = `
      if (typeof require !== "undefined") {
        throw new Error("native ESM harness unexpectedly exposed require");
      }
      const loggerModule = await import(${JSON.stringify(url)});
      loggerModule.logger.info(${JSON.stringify(outputMarker)});
      loggerModule.logPrompt("text", ${JSON.stringify(promptMarker)}, {
        agentName: "native-esm",
      });
      loggerModule.logChatIn({
        agentName: "native-esm",
        agentId: "agent-native-esm",
        roomId: "room-native-esm",
        messageId: "message-native-esm",
        text: ${JSON.stringify(chatMarker)},
      });
      if (!loggerModule.recentLogs().includes(${JSON.stringify(outputMarker)})) {
        throw new Error("native ESM log entry did not reach recentLogs");
      }
      console.log(${JSON.stringify(successMarker)});
    `;

  const result = spawnSync(
    process.execPath,
    [...loaderArgs, "--input-type=module", "--eval", childScript],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        LOG_FILE: outputPath,
        LOG_JSON_FORMAT: "true",
        LOG_LEVEL: "info",
        NO_COLOR: "1",
      },
    },
  );

  const childOutput = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n");
  expect(result.status, childOutput).toBe(0);
  expect(result.stdout).toContain(successMarker);
  expect(readFileSync(outputPath, "utf8")).toContain(outputMarker);
  expect(readFileSync(join(directory, "prompts.log"), "utf8")).toContain(
    promptMarker,
  );
  expect(readFileSync(join(directory, "chat.log"), "utf8")).toContain(
    chatMarker,
  );
}

describe("native Node ESM", () => {
  const sourceUrl = new URL("./logger.ts", import.meta.url).href;
  const distUrl = new URL("../dist/index.js", import.meta.url).href;

  it("initializes source JSON mode and writes every file sink", () => {
    verifyNativeEsmTarget({
      name: "source",
      url: sourceUrl,
      loaderArgs: ["--import", "tsx"],
    });
  });

  it.skipIf(!existsSync(fileURLToPath(distUrl)))(
    "initializes the built package through plain Node ESM",
    () => {
      verifyNativeEsmTarget({ name: "dist", url: distUrl });
    },
  );
});
