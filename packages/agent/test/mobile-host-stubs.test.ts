/**
 * Host-selected mobile stubs (ELIZA_MOBILE_STUB_PLUGINS). The list merges into
 * the build's stub table, its resolver runs before every other resolver, and a
 * longer alias still keeps its source. A separate Bun process bundles and runs
 * an entry through the same resolver.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import {
  matchStubAlias,
  mergeMobileStubPlugins,
  parseMobileStubPlugins,
} from "../scripts/mobile-stub-plugins.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("parses the host list and merges it over the stub table", () => {
  expect(parseMobileStubPlugins(undefined)).toEqual([]);
  expect(
    parseMobileStubPlugins(
      " googleapis,@elizaos/plugin-discord\n three googleapis ",
    ),
  ).toEqual(["@elizaos/plugin-discord", "googleapis", "three"]);
  for (const bad of ["./local", "/abs", "@scope", "pkg/../other", "x:y"])
    expect(() => parseMobileStubPlugins(bad), bad).toThrow(
      /not a bare package specifier/,
    );

  const merged = mergeMobileStubPlugins(
    {
      "@elizaos/plugin-browser": "/src/plugin-browser/mobile.ts",
      "@elizaos/plugin-browser/schema": "/src/plugin-browser/schema.ts",
      sharp: "/stubs/sharp.ts",
    },
    ["@elizaos/plugin-browser", "googleapis"],
    "/stubs/null-plugin.ts",
  );
  expect(merged).toEqual({
    "@elizaos/plugin-browser": "/stubs/null-plugin.ts",
    "@elizaos/plugin-browser/schema": "/src/plugin-browser/schema.ts",
    sharp: "/stubs/sharp.ts",
    googleapis: "/stubs/null-plugin.ts",
  });
  const names = Object.keys(merged);
  expect(matchStubAlias("googleapis/build/src/apis/gmail", names)).toBe(
    "googleapis",
  );
  expect(matchStubAlias("@elizaos/plugin-browser/schema", names)).toBe(
    "@elizaos/plugin-browser/schema",
  );
  expect(matchStubAlias("googleapis-common", names)).toBeNull();
});

it("is installed first by the mobile bundle build", async () => {
  const source = await readFile(
    path.join(HERE, "..", "scripts", "build-mobile-bundle.ts"),
    "utf8",
  );
  expect(source).toMatch(/plugins: \[\n\s+hostStubResolverPlugin,\n/);
  expect(source).toMatch(
    /process\.env\[MOBILE_STUB_PLUGINS_ENV\][\s\S]+hostStubs: hostStubPlugins/,
  );
  // Source subpaths that app code imports at boot stay real under a host stub.
  for (const [alias, file] of [
    ["@elizaos/plugin-browser/schema", "plugins/plugin-browser/src/schema.ts"],
    [
      "@elizaos/plugin-calendar/format",
      "plugins/plugin-calendar/src/internal/format.ts",
    ],
  ]) {
    expect(source).toContain(`"${alias}": path.join(`);
    expect(source).toContain(`"${file}"`);
  }
});

it("bundles host-stubbed packages as the throw-on-call stub", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "eliza-mobile-host-stub-"));
  directories.push(workDir);
  const { status, stdout, stderr } = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      "bun",
      [
        path.join(HERE, "fixtures", "mobile-host-stub-bundle-child.ts"),
        workDir,
      ],
      { cwd: path.join(HERE, "..") },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`host stub bundle child timed out\n${err}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: err });
    });
  });
  expect(status, stderr).toBe(0);
  const line = stdout
    .split("\n")
    .find((row) => row.startsWith("HOST_STUB_RESULT="));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line?.slice("HOST_STUB_RESULT=".length) ?? "{}");
  // Neither the package nor the later resolver's copy is bundled.
  expect(
    result.inputs.filter((input: string) =>
      /node_modules[\\/]heavy|dedupe[\\/]heavy/.test(input),
    ),
  ).toEqual([]);
  expect(result.run).toEqual({
    value: "undefined",
    sub: "object",
    failed: true,
    kept: "source-alias",
  });
});
