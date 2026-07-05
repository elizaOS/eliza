/**
 * Fail-fast SSH-key availability tests.
 *
 * The provisioning worker calls `assertSSHKeyAvailable()` at boot so a
 * misconfigured key crashes loudly instead of letting the daemon publish a
 * healthy heartbeat while silently failing every node SSH. These exercise the
 * real accessor against the real filesystem (a temp key file), toggling the
 * real env vars — no mocking of the module under test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertSSHKeyAvailable, containersEnv } from "./containers-env";

const KEYS = [
  "CONTAINERS_SSH_KEY",
  "AGENT_SSH_KEY",
  "CONTAINERS_SSH_KEY_PATH",
  "AGENT_SSH_KEY_PATH",
] as const;

const saved = new Map<string, string | undefined>();
let tmpDir: string;

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-key-test-"));
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("assertSSHKeyAvailable", () => {
  test("throws when neither an inline key nor a key path is configured", () => {
    expect(containersEnv.resolveSshKeySource()).toEqual({ kind: "none" });
    expect(() => assertSSHKeyAvailable()).toThrow(/neither CONTAINERS_SSH_KEY .* nor CONTAINERS_SSH_KEY_PATH/);
  });

  test("throws when the key PATH is set but the file is missing", () => {
    const missing = path.join(tmpDir, "does-not-exist");
    process.env.CONTAINERS_SSH_KEY_PATH = missing;
    expect(containersEnv.resolveSshKeySource()).toEqual({ kind: "file", path: missing });
    expect(() => assertSSHKeyAvailable()).toThrow(/SSH key unavailable/);
  });

  test("passes when the key path points at a readable file", () => {
    const keyFile = path.join(tmpDir, "id_ed25519");
    fs.writeFileSync(keyFile, "PRIVATE KEY", { mode: 0o600 });
    process.env.CONTAINERS_SSH_KEY_PATH = keyFile;
    expect(() => assertSSHKeyAvailable()).not.toThrow();
  });

  test("passes on an inline base64 key even with no key path", () => {
    process.env.CONTAINERS_SSH_KEY = Buffer.from("inline-key").toString("base64");
    expect(containersEnv.resolveSshKeySource()).toEqual({ kind: "inline" });
    expect(() => assertSSHKeyAvailable()).not.toThrow();
  });
});
