import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkConfigFile,
  checkHostConfig,
  checkPort,
  runAllChecks,
} from "./doctor";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("doctor configuration boundaries", () => {
  function check(contents: string) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "eliza-doctor-"));
    directories.push(directory);
    const file = path.join(directory, "config.json5");
    writeFileSync(file, contents);
    return checkConfigFile(file, {});
  }

  it("accepts the JSON5 syntax supported by the configuration loader", () => {
    expect(check("{ // comment\n name: 'Eliza', }").status).toBe("pass");
  });

  it.each(["null", "[]", "42", "{broken"])(
    "rejects invalid configuration %s",
    (contents) => {
      expect(check(contents).status).toBe("fail");
    },
  );

  it.each(["::1", "[::1]", "0:0:0:0:0:0:0:1", "127.0.0.1"])(
    "uses runtime loopback classification for %s",
    (host) => {
      expect(checkHostConfig({ ELIZA_API_BIND: host })).toMatchObject({
        status: "pass",
        detail: "Loopback only (default)",
      });
    },
  );

  it.each(["::", "0.0.0.0"])(
    "warns for unconfigured wildcard binding %s",
    (host) => {
      expect(checkHostConfig({ ELIZA_API_BIND: host }).status).toBe("warn");
    },
  );
});

describe("doctor port availability", () => {
  it.each([0, -1, 65536, 1.5, Number.NaN])(
    "rejects invalid port %s",
    async (port) => {
      expect((await checkPort(port)).status).toBe("fail");
    },
  );

  it("detects a real listener and releases its successful bind probe", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener port");
    try {
      expect((await checkPort(address.port)).status).toBe("warn");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect((await checkPort(address.port)).status).toBe("pass");
    expect((await checkPort(address.port)).status).toBe("pass");
  });
});

describe("doctor reads what `eliza setup` saves", () => {
  async function runWithConfig(contents: string) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "eliza-doctor-"));
    directories.push(directory);
    const configPath = path.join(directory, "eliza.json");
    writeFileSync(configPath, contents);
    return runAllChecks({
      env: {},
      configPath,
      projectRoot: directory,
      checkPorts: false,
    });
  }

  it.each([
    ['{ env: { OPENAI_API_KEY: "sk-test" } }', "OPENAI_API_KEY"],
    ['{ env: { vars: { GROQ_API_KEY: "gsk-test" } } }', "GROQ_API_KEY"],
  ])(
    "finds a provider key saved in the config env section %s",
    async (contents, key) => {
      const results = await runWithConfig(contents);
      expect(results.find((r) => r.label === "Model API key")).toMatchObject({
        status: "pass",
        detail: expect.stringContaining(key),
      });
    },
  );

  it("still fails when neither the env nor the config has a key", async () => {
    const results = await runWithConfig("{ env: {} }");
    expect(results.find((r) => r.label === "Model API key")?.status).toBe(
      "fail",
    );
  });

  it("names a canonical config load failure instead of sending --fix to setup", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "eliza-doctor-"));
    directories.push(directory);
    const configPath = path.join(directory, "eliza.json");
    const persistPath = path.join(directory, "persisted.json");
    // The base file is valid (the Config file check passes); only the persist
    // file the canonical loader also reads is malformed.
    writeFileSync(configPath, "{}");
    writeFileSync(persistPath, "{ env: { OPENAI_API_KEY: ");
    const env = {
      ELIZA_CONFIG_PATH: configPath,
      ELIZA_PERSIST_CONFIG_PATH: persistPath,
      ELIZA_STATE_DIR: directory,
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    const results = await runAllChecks({
      env,
      projectRoot: directory,
      checkPorts: false,
    });

    expect(results.find((r) => r.label === "Config file")?.status).toBe("pass");
    const modelKey = results.find((r) => r.label === "Model API key");
    expect(modelKey).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("could not read config env:"),
      autoFixable: false,
    });
    expect(modelKey?.fix).not.toBe("eliza setup");
  });

  it("does not check the retired ./eliza vendored-upstreams layout", async () => {
    const results = await runWithConfig("{}");
    expect(results.map((r) => r.label)).not.toContain("Local upstreams");
    expect(results.some((r) => r.fix?.includes("setup:upstreams"))).toBe(false);
  });
});
