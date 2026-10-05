import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureHostExecutionBaseline } from "@elizaos/host";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  AppleContainerEngine,
  DockerEngine,
} from "../src/services/sandbox-engine.ts";

const cwd = process.cwd();
const originalPath = process.env.PATH;
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), "eliza-engine-process-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  for (const name of ["docker", "container"]) {
    copyFileSync(
      process.execPath,
      path.join(bin, name + (process.platform === "win32" ? ".exe" : "")),
    );
  }
  // A real Node executable consumes the engine's first argument as this file.
  // The remaining arguments and OS pipes exercise the production CLI boundary.
  writeFileSync(
    path.join(directory, "exec"),
    `
if (process.argv.includes("unicode")) {
  process.stdout.write(Buffer.from([0xc3]));
  process.stderr.write(Buffer.from([0xe4]));
  setTimeout(() => {
    process.stdout.write(Buffer.from([0xa9]));
    process.stderr.write(Buffer.from([0xb8, 0x96]));
    process.exitCode = 7;
  }, 150);
} else if (process.argv.includes("hang")) {
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({input, args: process.argv.slice(2)})));
}
`,
  );
  process.chdir(directory);
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  captureHostExecutionBaseline();
});

afterAll(() => {
  process.chdir(cwd);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  captureHostExecutionBaseline();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const Engine of [DockerEngine, AppleContainerEngine]) {
  it(`${Engine.name} preserves split UTF-8 and the actual child exit code`, async () => {
    expect(
      await new Engine().execInContainer({
        containerId: "fixture",
        command: "unicode",
      }),
    ).toMatchObject({
      stdout: "é",
      stderr: "世",
      exitCode: 7,
    });
  });
  it.each([undefined, "", "hello 世界"])(
    `${Engine.name} closes stdin for %s`,
    async (stdin) => {
      const result = await new Engine().execInContainer({
        containerId: "fixture",
        command: "read-input 'one argument'",
        stdin,
        timeoutMs: 5000,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        input: stdin ?? "",
        args: [
          ...(stdin === undefined ? [] : ["--interactive"]),
          "fixture",
          "read-input",
          "one argument",
        ],
      });
    },
  );
  it(`${Engine.name} terminates a child which exceeds its timeout`, async () => {
    const result = await new Engine().execInContainer({
      containerId: "fixture",
      command: "hang",
      timeoutMs: 500,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(450);
  });
}
