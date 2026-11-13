import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  clearPasswordManagerBackendCache,
  detectPasswordManagerBackend,
  injectCredentialToClipboard,
  listPasswordItems,
} from "@elizaos/plugin-browser/password-manager-bridge";
import { afterEach, expect, it } from "vitest";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.js";
import {
  type BenchmarkRuntimeFixturesEnvironment,
  createBenchmarkRuntimeFixturesEnvironment,
} from "./support/helpers/benchmark-runtime-fixtures.js";

const originalEnv = { ...process.env };
let directory: string | undefined;
let fixture: BenchmarkRuntimeFixturesEnvironment | undefined;

afterEach(async () => {
  try {
    await fixture?.cleanup();
  } finally {
    fixture = undefined;
    process.env = { ...originalEnv };
    clearPasswordManagerBackendCache();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "switches into and out of the isolated CLI fixture despite cached detection",
  async () => {
    const output = testOutputPath("benchmark-password-manager");
    await mkdir(output, { recursive: true });
    directory = await mkdtemp(path.join(output, "case-"));
    process.env.PATH = directory;
    clearPasswordManagerBackendCache();
    expect(await detectPasswordManagerBackend()).toBe("none");

    fixture = await createBenchmarkRuntimeFixturesEnvironment();
    Object.assign(process.env, fixture.envVars);
    expect(await detectPasswordManagerBackend()).toBe("1password");
    expect((await listPasswordItems({})).map((item) => item.id)).toEqual([
      "pm-github",
      "pm-google-workspace",
      "pm-aws-prod",
    ]);
    await injectCredentialToClipboard("pm-github", "password");
    expect(
      await readFile(fixture.envVars.BENCHMARK_CLIPBOARD_FILE, "utf8"),
    ).toBe("benchmark-password");

    await fixture.cleanup();
    fixture = undefined;
    process.env.PATH = directory;
    expect(await detectPasswordManagerBackend()).toBe("none");
  },
);
