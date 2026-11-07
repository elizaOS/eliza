import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureHostExecutionBaseline } from "@elizaos/host";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  AppleContainerEngine,
  type ContainerRunOptions,
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
if (process.argv.includes("close-input")) {
  process.exit(0);
} else if (process.argv.includes("unicode")) {
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
  writeFileSync(
    path.join(directory, "system"),
    `
const fs = require("node:fs");
if (process.argv[2] !== "status") process.exit(2);
process.exit(Number(fs.readFileSync("service-status", "utf8")));
`,
  );
  writeFileSync(
    path.join(directory, "run"),
    `
const fs = require("node:fs");
fs.writeFileSync("run-args", JSON.stringify(process.argv.slice(2)));
const { delay, code } = JSON.parse(fs.readFileSync("run-result", "utf8"));
setTimeout(() => { process.exitCode = code; }, delay);
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
  it(`${Engine.name} reports a child closing stdin before consuming the input`, async () => {
    const result = await new Engine().execInContainer({
      containerId: "fixture",
      command: "close-input",
      stdin: "x".repeat(2 * 1024 * 1024),
      timeoutMs: 5000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("stdin");
  });
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

it("Apple Container availability requires a responsive service", () => {
  const engine = new AppleContainerEngine();
  writeFileSync(path.join(directory, "service-status"), "1");
  expect(engine.isAvailable()).toBe(false);
  writeFileSync(path.join(directory, "service-status"), "0");
  expect(engine.isAvailable()).toBe(true);
});

const runOptions: ContainerRunOptions = {
  image: "fixture:image",
  name: "fixture",
  detach: true,
  mounts: [{ host: "/host path", container: "/workspace", readonly: true }],
  env: { FIXTURE: "one argument" },
  network: "",
  user: "",
  capDrop: [],
};

it.each([true, false])(
  "Apple Container waits for CLI completion with detach=%s",
  async (detach) => {
    writeFileSync(
      path.join(directory, "run-result"),
      JSON.stringify({ delay: 0, code: 0 }),
    );
    await expect(
      new AppleContainerEngine().runContainer({ ...runOptions, detach }),
    ).resolves.toBe("fixture");
    expect(
      JSON.parse(readFileSync(path.join(directory, "run-args"), "utf8")),
    ).toEqual([
      ...(detach ? ["--detach"] : []),
      "--name",
      "fixture",
      "--mount",
      "type=bind,source=/host path,target=/workspace,readonly",
      "-e",
      "FIXTURE=one argument",
      "fixture:image",
    ]);
  },
);

it("Apple Container reports startup failure even after the former two-second readiness window", async () => {
  writeFileSync(
    path.join(directory, "run-result"),
    JSON.stringify({ delay: 2200, code: 17 }),
  );
  await expect(
    new AppleContainerEngine().runContainer(runOptions),
  ).rejects.toMatchObject({
    code: "SANDBOX_APPLE_CONTAINER_START_FAILED",
    cause: { message: "Container process exited with 17" },
  });
});
