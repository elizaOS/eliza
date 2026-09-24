import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfigFile, checkHostConfig } from "./checks";

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
