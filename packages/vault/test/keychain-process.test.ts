/** Exercises real child-process key reads, verified creation, and timeout termination using an isolated binding fixture. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readKeychainKeySync } from "../src/keychain-process.js";

const directories: string[] = [];
function fixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), "eliza-keychain-process-"));
  directories.push(directory);
  const binding = join(directory, "binding.mjs");
  writeFileSync(binding, body);
  return { directory, binding };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("returns an existing key without invoking a write", () => {
  const key = Buffer.alloc(32, 17);
  const { binding } = fixture(`export class Entry {
    getPassword() { return ${JSON.stringify(key.toString("base64"))}; }
    setPassword() { throw new Error("unexpected write"); }
  }`);
  expect(readKeychainKeySync("test", "existing", { binding })).toEqual(key);
});

it("persists and verifies a newly created key before returning it", () => {
  const { directory, binding } = fixture(`
    import { readFileSync, writeFileSync, existsSync } from "node:fs";
    const file = new URL("./saved-key", import.meta.url);
    export class Entry {
      getPassword() { return existsSync(file) ? readFileSync(file, "utf8") : null; }
      setPassword(value) { writeFileSync(file, value); }
    }
  `);
  const key = readKeychainKeySync("test", "create", { binding });
  expect(key.toString("base64")).toBe(
    readFileSync(join(directory, "saved-key"), "utf8"),
  );
  expect(readKeychainKeySync("test", "create", { binding })).toEqual(key);
});

it("does not turn a failed read into creation or disclose native error text", () => {
  const { directory, binding } = fixture(`
    import { writeFileSync } from "node:fs";
    export class Entry {
      getPassword() { throw new Error("sensitive-native-error"); }
      setPassword() { writeFileSync(new URL("./overwrite", import.meta.url), "bad"); }
    }
  `);
  expect(() => readKeychainKeySync("test", "failure", { binding })).toThrow(
    /Unlock the login Keychain/,
  );
  expect(() => readFileSync(join(directory, "overwrite"))).toThrow();
  try {
    readKeychainKeySync("test", "failure", { binding });
  } catch (error) {
    // error-policy:J1 Assert the sanitized subprocess failure boundary.
    expect(String(error)).not.toContain("sensitive-native-error");
  }
});

it("rejects corrupt stored keys and unsuccessful read-back", () => {
  for (const implementation of [
    'getPassword() { return "corrupt"; } setPassword() { throw new Error("overwrite"); }',
    "getPassword() { return null; } setPassword() {}",
  ]) {
    const { binding } = fixture(`export class Entry { ${implementation} }`);
    expect(() => readKeychainKeySync("test", "invalid", { binding })).toThrow();
  }
});

it("kills a native read that blocks indefinitely and permits a later retry", () => {
  const { directory, binding } = fixture(`
    import { writeFileSync } from "node:fs";
    export class Entry {
      getPassword() {
        writeFileSync(new URL("./child-pid", import.meta.url), String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
  `);
  const started = Date.now();
  expect(() =>
    readKeychainKeySync("test", "blocked", { binding, timeoutMs: 500 }),
  ).toThrow(/Keychain/);
  expect(Date.now() - started).toBeLessThan(5_000);
  const pid = Number(readFileSync(join(directory, "child-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  writeFileSync(
    binding,
    `export class Entry {
    getPassword() { return ${JSON.stringify(Buffer.alloc(32, 23).toString("base64"))}; }
  }`,
  );
  expect(readKeychainKeySync("test", "blocked", { binding })).toEqual(
    Buffer.alloc(32, 23),
  );
});
