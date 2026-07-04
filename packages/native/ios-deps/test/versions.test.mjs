import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packageRoot = new URL("..", import.meta.url);

function parseVersionsFile() {
  const text = readFileSync(new URL("../VERSIONS", import.meta.url), "utf8");
  return new Map(
    text
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `Malformed VERSIONS line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test("native iOS dependency pins cover build inputs", () => {
  const versions = parseVersionsFile();

  assert.equal(versions.get("llama.cpp"), "ce85787c8");
  assert.equal(versions.get("sqlite-vec"), "v0.1.6");
  assert.equal(versions.get("tinycc"), undefined);
  assert.equal(versions.get("libuv"), undefined);
});

test("iOS dependency build scripts are present and executable", () => {
  for (const script of ["llama.cpp/build-ios.sh", "sqlite-vec/build-ios.sh"]) {
    const absolute = join(packageRoot.pathname, script);
    accessSync(absolute, constants.R_OK | constants.X_OK);
  }
});
