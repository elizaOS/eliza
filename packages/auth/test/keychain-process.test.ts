/** Exercises real child-process key reads, verified creation, and timeout termination using an isolated binding fixture. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { readKeychainKeySync } from "../src/vault/keychain-process.js";

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

it("returns a verified key when the native binding writes verbose diagnostics", () => {
  const key = Buffer.alloc(32, 19);
  const { binding } = fixture(`export class Entry {
    getPassword() {
      process.stderr.write("native-diagnostic".repeat(4096));
      return ${JSON.stringify(key.toString("base64"))};
    }
    setPassword() { throw new Error("unexpected write"); }
  }`);
  expect(readKeychainKeySync("test", "verbose", { binding })).toEqual(key);
});

it("returns the verified protocol result even when the binding retains an event-loop handle", () => {
  const key = Buffer.alloc(32, 29);
  const { binding } = fixture(`
    setInterval(() => {}, 1000);
    export class Entry {
      getPassword() { return ${JSON.stringify(key.toString("base64"))}; }
      setPassword() { throw new Error("unexpected write"); }
    }
  `);
  expect(
    readKeychainKeySync("test", "retained-handle", { binding, timeoutMs: 500 }),
  ).toEqual(key);
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

it("does not replace an existing empty keychain entry", () => {
  const { directory, binding } = fixture(`
    import { readFileSync, writeFileSync } from "node:fs";
    const file = new URL("./saved-key", import.meta.url);
    export class Entry {
      getPassword() { return readFileSync(file, "utf8"); }
      setPassword(value) { writeFileSync(file, value); }
    }
  `);
  const savedKey = join(directory, "saved-key");
  writeFileSync(savedKey, "");
  expect(() => readKeychainKeySync("test", "empty", { binding })).toThrow();
  expect(readFileSync(savedKey, "utf8")).toBe("");
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
  // Exercise the production deadline. A shorter test-only timeout can expire
  // during Node startup, before this fixture reaches the blocking native read.
  expect(() => readKeychainKeySync("test", "blocked", { binding })).toThrow(
    /Keychain/,
  );
  expect(Date.now() - started).toBeLessThan(10_000);
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

it("uses explicit Node for a Bun host without changing the application runtime", () => {
  const { directory, binding } = fixture(`
    import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./loaded", import.meta.url), "loaded");
    export class Entry {
      getPassword() {
        writeFileSync(new URL("./runtime", import.meta.url), process.versions.bun ? "bun" : "node");
        return Buffer.alloc(32, 31).toString("base64");
      }
      setPassword() { throw new Error("unexpected write"); }
    }
  `);
  const modulePath = fileURLToPath(
    new URL("../src/vault/keychain-process.ts", import.meta.url),
  );
  const runner = join(directory, "runner.ts");
  writeFileSync(
    runner,
    `import {readKeychainKeySync} from ${JSON.stringify(modulePath)};
    try { const key = readKeychainKeySync("test", "runtime-choice", {binding: ${JSON.stringify(binding)}, timeoutMs: 500});
      if (key.length !== 32 || !process.versions.bun) process.exit(9);
    } catch (error) { console.log(error.message); process.exit(1); }`,
  );
  const run = (nodePath: string) =>
    spawnSync("bun", [runner], {
      env: { ...process.env, ELIZA_NODE_PATH: nodePath },
      encoding: "utf8",
      timeout: 3000,
    });
  expect(run(process.execPath).status).toBe(0);
  expect(readFileSync(join(directory, "runtime"), "utf8")).toBe("node");
  expect(run("").status).toBe(0);
  expect(readFileSync(join(directory, "runtime"), "utf8")).toBe("bun");
  for (const badPath of ["relative-node", join(directory, "missing-node")]) {
    const result = run(badPath);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invalid ELIZA_NODE_PATH");
    expect(result.stdout).not.toContain(badPath);
    expect(readFileSync(join(directory, "runtime"), "utf8")).toBe("bun");
  }
  const bunPath = spawnSync("bun", ["--print", "process.execPath"], {
    encoding: "utf8",
  }).stdout.trim();
  rmSync(join(directory, "loaded"));
  const wrongRuntime = run(bunPath);
  expect(wrongRuntime.status).toBe(1);
  expect(wrongRuntime.stdout).toContain("Invalid ELIZA_NODE_PATH");
  expect(existsSync(join(directory, "loaded"))).toBe(false);

  writeFileSync(
    binding,
    `import {writeFileSync} from "node:fs";
    export class Entry {
      getPassword() {
        writeFileSync(new URL("./blocked-pid", import.meta.url), String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      setPassword() { writeFileSync(new URL("./overwrite", import.meta.url), "bad"); }
    }`,
  );
  const blocked = run(process.execPath);
  expect(blocked.status).toBe(1);
  expect(blocked.stdout).toContain("Keychain");
  expect(blocked.stdout).not.toContain("Invalid ELIZA_NODE_PATH");
  expect(existsSync(join(directory, "overwrite"))).toBe(false);
  const pid = Number(readFileSync(join(directory, "blocked-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
