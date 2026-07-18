/**
 * Exercises the macOS Keychain password PTY protocol against a fake security
 * executable, so prompt handling and process secrecy are proven without
 * reading or mutating the host Keychain.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MacOSKeychainPasswordWriteError,
  writeMacOSKeychainPassword,
} from "../src/macos-keychain-password.js";

const EXPECT_PATH = "/usr/bin/expect";
const STTY_PATH = "/bin/stty";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("writeMacOSKeychainPassword input validation", () => {
  it("rejects empty and multiline passwords before spawning", () => {
    expect(() => writeMacOSKeychainPassword("service", "account", "")).toThrow(
      /non-empty single line/,
    );
    expect(() =>
      writeMacOSKeychainPassword("service", "account", "line-one\nline-two"),
    ).toThrow(/non-empty single line/);
  });

  it("surfaces expect spawn errors", async () => {
    await expect(
      writeMacOSKeychainPassword("service", "account", "stdin-only-secret", {
        expectExecutable: "/path/that/does/not/exist/expect",
      }),
    ).rejects.toThrow(/failed to start macOS Keychain prompt helper/);
  });
});

describe.runIf(process.platform === "darwin")(
  "writeMacOSKeychainPassword PTY protocol",
  () => {
    let testDir = "";

    beforeEach(async () => {
      testDir = await mkdtemp(join(tmpdir(), "eliza-keychain-pty-test-"));
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    async function createFakeSecurity(
      mode: "success" | "exit" | "missing-retype" | "timeout",
    ): Promise<string> {
      const executable = join(testDir, `fake-security-${mode}.mjs`);
      const source = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
if (mode === "timeout") {
  setTimeout(() => {}, 30000);
} else {
  const accountIndex = process.argv.indexOf("-a");
  const reportPath = accountIndex >= 0 ? process.argv[accountIndex + 1] : "";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const setEcho = (enabled) =>
    spawnSync(${JSON.stringify(STTY_PATH)}, [enabled ? "echo" : "-echo"], {
      stdio: ["inherit", "ignore", "inherit"],
    });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  setEcho(false);
  process.stdout.write("password data for new item: ");
  const first = (await iterator.next()).value ?? "";

  if (mode === "missing-retype") {
    setEcho(true);
    lines.close();
    process.exit(0);
  }

  process.stdout.write("retype password for new item: ");
  const second = (await iterator.next()).value ?? "";
  setEcho(true);
  lines.close();

  const argvLeak = process.argv.slice(2).some((value) => value.includes(first));
  const envLeak = Object.values(process.env).some(
    (value) => typeof value === "string" && value.includes(first),
  );
  if (reportPath) {
    writeFileSync(
      reportPath,
      JSON.stringify({
        argv: process.argv.slice(2),
        argvLeak,
        envLeak,
        firstDigest: hash(first),
        secondDigest: hash(second),
      }),
    );
  }

  if (mode === "exit") {
    process.stderr.write(\`simulated keychain rejection: \${first}\\n\`);
    process.exit(52);
  }
}
`;
      await writeFile(executable, source, "utf8");
      await chmod(executable, 0o700);
      return executable;
    }

    it("delivers the password only on stdin and answers both exact prompts", async () => {
      const password = `pty-only-${randomUUID()}`;
      const reportPath = join(testDir, "success-report.json");
      const securityExecutable = await createFakeSecurity("success");

      await writeMacOSKeychainPassword(
        "unit-test-service",
        reportPath,
        password,
        {
          expectExecutable: EXPECT_PATH,
          securityExecutable,
          timeoutMs: 2_000,
        },
      );

      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        argv: string[];
        argvLeak: boolean;
        envLeak: boolean;
        firstDigest: string;
        secondDigest: string;
      };
      expect(report.argv).toEqual([
        "add-generic-password",
        "-s",
        "unit-test-service",
        "-a",
        reportPath,
        "-U",
        "-w",
      ]);
      expect(report.argvLeak).toBe(false);
      expect(report.envLeak).toBe(false);
      expect(report.firstDigest).toBe(digest(password));
      expect(report.secondDigest).toBe(digest(password));
    });

    it("preserves exit diagnostics while redacting secret output", async () => {
      const password = `redact-${randomUUID()}`;
      const reportPath = join(testDir, "exit-report.json");
      const securityExecutable = await createFakeSecurity("exit");

      let failure: unknown;
      try {
        await writeMacOSKeychainPassword(
          "unit-test-service",
          reportPath,
          password,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 2_000,
          },
        );
      } catch (err) {
        failure = err;
      }

      expect(failure).toBeInstanceOf(MacOSKeychainPasswordWriteError);
      const error = failure as MacOSKeychainPasswordWriteError;
      expect(error.code).toBe(52);
      expect(error.message).toContain("simulated keychain rejection");
      expect(error.message).toContain("[REDACTED]");
      expect(error.message).not.toContain(password);
      expect(error.stderr).not.toContain(password);
    });

    it("fails when security exits before the retype prompt", async () => {
      const securityExecutable = await createFakeSecurity("missing-retype");
      await expect(
        writeMacOSKeychainPassword(
          "unit-test-service",
          join(testDir, "missing-report.json"),
          `missing-${randomUUID()}`,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 2_000,
          },
        ),
      ).rejects.toMatchObject({ code: 70 });
    });

    it("terminates a command that never emits the first prompt", async () => {
      const securityExecutable = await createFakeSecurity("timeout");
      await expect(
        writeMacOSKeychainPassword(
          "unit-test-service",
          join(testDir, "timeout-report.json"),
          `timeout-${randomUUID()}`,
          {
            expectExecutable: EXPECT_PATH,
            securityExecutable,
            timeoutMs: 100,
          },
        ),
      ).rejects.toMatchObject({ code: 124 });
    });
  },
);
