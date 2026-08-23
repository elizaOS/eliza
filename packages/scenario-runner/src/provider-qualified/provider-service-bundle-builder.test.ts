/**
 * Exercises the production deployment-module builder against real temporary
 * files and Bun's bundler. The tests inspect bytes without starting a service,
 * resolving credentials, contacting providers, or claiming qualification.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPinnedSelfContainedModuleBytes } from "./operator-file-security.ts";

const REQUIRED_FACTORY_EXPORT =
  "createProviderCanaryServiceDeployment" as const;

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  directory: string;
  entryFile: string;
  outputFile: string;
}> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "provider-service-bundle-builder-")),
  );
  temporaryDirectories.push(directory);
  return {
    directory,
    entryFile: path.join(directory, "deployment-entry.ts"),
    outputFile: path.join(directory, "deployment-adapter.mjs"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runBuilder(files: {
  entryFile: string;
  outputFile: string;
}): SpawnSyncReturns<string> {
  const inheritedBun = [
    process.env.npm_execpath,
    process.env.BUN,
    process.env._,
  ].find((candidate) => candidate && path.basename(candidate) === "bun");
  return spawnSync(
    inheritedBun ?? "bun",
    [
      "--conditions",
      "eliza-source",
      "--tsconfig-override",
      "../../tsconfig.json",
      "scripts/build-provider-service-deployment-bundle.ts",
      "--entry",
      files.entryFile,
      "--out",
      files.outputFile,
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      timeout: 120_000,
    },
  );
}

describe("provider service deployment bundle builder", () => {
  it("bundles the real Twilio role assembly into loader-accepted bytes", async () => {
    const files = await fixture();
    const assembly = path.join(
      import.meta.dirname,
      "twilio-provider-service-deployment.ts",
    );
    await writeFile(
      files.entryFile,
      [
        `import { createTwilioProviderCanaryServiceDeploymentFactory } from ${JSON.stringify(assembly)};`,
        "export const createProviderCanaryServiceDeployment =",
        "  createTwilioProviderCanaryServiceDeploymentFactory({",
        "    async base() { throw new Error('deployment-owned base loader unavailable'); },",
        "  });",
        "",
      ].join("\n"),
    );
    const execution = runBuilder(files);
    expect(execution.status, execution.stderr).toBe(0);
    const bytes = await readFile(files.outputFile);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(execution.stdout).toBe(`${sha256}  ${files.outputFile}\n`);
    expect((await stat(files.outputFile)).mode & 0o777).toBe(0o600);
    expect(bytes.toString("utf8")).not.toContain(assembly);
    expect(() =>
      inspectPinnedSelfContainedModuleBytes(
        bytes,
        sha256,
        REQUIRED_FACTORY_EXPORT,
      ),
    ).not.toThrow();
  });

  it("refuses runtime module loaders and leaves no output", async () => {
    const files = await fixture();
    await writeFile(
      files.entryFile,
      "export function createProviderCanaryServiceDeployment() { return import('node:fs'); }\n",
    );
    const execution = runBuilder(files);
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/forbidden dynamic import/);
    await expect(stat(files.outputFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses embedded private keys and leaves no output", async () => {
    const files = await fixture();
    await writeFile(
      files.entryFile,
      [
        "const value = '-----BEGIN PRIVATE KEY-----';",
        "export function createProviderCanaryServiceDeployment() { return value; }",
        "",
      ].join("\n"),
    );
    const execution = runBuilder(files);
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/must not embed private key material/);
    await expect(stat(files.outputFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never overwrites an existing deployment artifact", async () => {
    const files = await fixture();
    await writeFile(
      files.entryFile,
      "export function createProviderCanaryServiceDeployment() {}\n",
    );
    await writeFile(files.outputFile, "reviewed-existing-bytes\n");
    const execution = runBuilder(files);
    expect(execution.status).not.toBe(0);
    expect(execution.stderr).toMatch(/output already exists/);
    expect(await readFile(files.outputFile, "utf8")).toBe(
      "reviewed-existing-bytes\n",
    );
  });
});
