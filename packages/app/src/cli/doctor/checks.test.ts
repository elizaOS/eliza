import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfigFile, checkHostConfig, checkPort } from "./checks";

const directories: string[] = [];
afterEach(() => {
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
