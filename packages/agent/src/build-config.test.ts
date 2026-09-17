/**
 * Exercises the agent's real TypeScript production emit without writing files.
 * Every compiler output must stay in agent/dist so sibling sources cannot gain
 * stale JavaScript or declarations that shadow their maintained TypeScript.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("agent production emit", () => {
  it("emits the public entrypoint and keeps every output inside agent/dist", () => {
    const config = ts.getParsedCommandLineOfConfigFile(
      path.join(packageRoot, "tsconfig.build.json"),
      // Match build:dist's noCheck emit; never reuse an incremental build here.
      { noCheck: true, incremental: false },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          throw new Error(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          );
        },
      },
    );
    if (!config)
      throw new Error("Agent build configuration could not be parsed");
    expect(config.errors).toEqual([]);
    const program = ts.createProgram({
      rootNames: config.fileNames,
      options: config.options,
    });
    const outputs: string[] = [];
    const result = program.emit(undefined, (filename) => {
      outputs.push(path.resolve(filename));
    });
    expect(result.emitSkipped).toBe(false);
    expect(result.diagnostics).toEqual([]);
    const outputRoot = path.join(packageRoot, "dist");
    expect(outputs).toContain(path.join(outputRoot, "index.js"));
    expect(
      outputs.filter(
        (filename) => !filename.startsWith(`${outputRoot}${path.sep}`),
      ),
    ).toEqual([]);
  });
});
