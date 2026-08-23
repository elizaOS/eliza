/** Compiles the Safari native error mapping and verifies the shared retry contract. */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const macOsIt = process.platform === "darwin" ? it : it.skip;
const execFileAsync = promisify(execFile);
const temporaryDirectories = [];
const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

macOsIt(
  "keeps Safari native error retryability aligned with the extension contract",
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "browser-bridge-safari-errors-"),
    );
    temporaryDirectories.push(directory);
    const harnessPath = path.join(directory, "ErrorContractHarness.swift");
    const executablePath = path.join(directory, "error-contract-harness");
    await fs.writeFile(
      harnessPath,
      `import Foundation

@main
struct ErrorContractHarness {
    static func main() {
        let cases: [(NativeEnrollmentError, String, Bool)] = [
            (.unsupportedProtocol, "unsupported_version", false),
            (.invalidRequest, "broker_unavailable", true),
            (.appNotAuthenticated, "app_not_authenticated", true),
            (.appNotRunning, "app_not_running", true),
            (.brokerUnavailable, "broker_unavailable", true),
        ]
        for (error, code, retryable) in cases {
            precondition(error.code == code)
            precondition(error.retryable == retryable)
        }
        print("native-error-contract-ok")
    }
}
`,
    );
    await execFileAsync("xcrun", [
      "swiftc",
      path.join(
        extensionRoot,
        "safari",
        "native",
        "SafariWebExtensionHandler.swift",
      ),
      harnessPath,
      "-framework",
      "SafariServices",
      "-o",
      executablePath,
    ]);
    const { stdout } = await execFileAsync(executablePath);
    expect(stdout.trim()).toBe("native-error-contract-ok");
  },
  30_000,
);
