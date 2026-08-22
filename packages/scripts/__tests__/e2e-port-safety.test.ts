/**
 * Guards tracked end-to-end harnesses against port-allocation races without a
 * historical count or exception baseline. Consumers must bind port zero and
 * retain the socket, or use the repository port-file handshake when another
 * process owns the listener. Probe-then-release allocation and literal host
 * listen or Docker-publish ports are always rejected.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SCRIPT_EXTENSION = /\.(?:mjs|cjs|js|ts|tsx|sh)$/;
const TOCTOU_ALLOCATOR = /\ballocateFreePorts\b/;
const LITERAL_LISTEN_PORT = /\.listen\(\s*["']?(\d{4,5})\b/;
const LITERAL_DOCKER_HOST_PORT =
  /(?:^|\s)(?:-p|--publish)(?:=|\s+)["']?(\d{4,5}):/;

function isE2eScript(file: string): boolean {
  return (
    SCRIPT_EXTENSION.test(file) &&
    file
      .toLowerCase()
      .split("/")
      .some((segment) => segment.includes("e2e"))
  );
}

function trackedE2eScripts(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file && isE2eScript(file));
}

function executableLines(
  file: string,
  content: string,
): Array<{ line: string; lineNumber: number }> {
  return content
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return file.endsWith(".sh")
        ? !trimmed.startsWith("#")
        : !trimmed.startsWith("//") &&
            !trimmed.startsWith("/*") &&
            !trimmed.startsWith("*");
    });
}

describe("e2e port safety", () => {
  it("covers each tracked e2e script family", () => {
    const files = trackedE2eScripts();
    for (const exemplar of [
      "packages/ui/src/cloud/organization/__e2e__/run-credentials-e2e.mjs",
      "packages/core/e2e/setup/global-setup.ts",
      "packages/cloud/shared/scripts/verify-e2e-container-db.sh",
      ".github/scripts/android-device-e2e/pr-device-smoke.sh",
    ]) {
      expect(files).toContain(exemplar);
    }
  });

  it("rejects probe-then-release port allocation", () => {
    const offenders = trackedE2eScripts().filter((file) => {
      if (file.endsWith("e2e-port-safety.test.ts")) return false;
      return TOCTOU_ALLOCATOR.test(
        readFileSync(path.join(REPO_ROOT, file), "utf8"),
      );
    });
    expect(
      offenders,
      "allocateFreePorts releases its probe socket before the consumer binds; " +
        "bind port 0 in the consumer or use packages/scripts/e2e-ports.mjs",
    ).toEqual([]);
  });

  it("rejects literal host listen and Docker-publish ports", () => {
    const offenders: string[] = [];
    for (const file of trackedE2eScripts()) {
      const content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      executableLines(file, content).forEach(({ line, lineNumber }) => {
        if (
          LITERAL_LISTEN_PORT.test(line) ||
          (file.endsWith(".sh") && LITERAL_DOCKER_HOST_PORT.test(line))
        ) {
          offenders.push(`${file}:${lineNumber}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "literal host ports collide under CI fan-out; bind port 0 and retain the " +
        "socket, or advertise the bound port through the port-file handshake",
    ).toEqual([]);
  });

  it("recognizes unsafe forms while accepting retained dynamic binds", () => {
    expect(LITERAL_LISTEN_PORT.test("server.listen(36414, host)")).toBe(true);
    expect(LITERAL_LISTEN_PORT.test("server.listen(0, host)")).toBe(false);
    expect(LITERAL_LISTEN_PORT.test("server.listen(boundPort, host)")).toBe(
      false,
    );
    expect(
      LITERAL_DOCKER_HOST_PORT.test("docker run --publish 8080:80 image"),
    ).toBe(true);
    expect(LITERAL_DOCKER_HOST_PORT.test("docker run -p 5432 image")).toBe(
      false,
    );
    expect(
      LITERAL_DOCKER_HOST_PORT.test('docker run -p "$HOST_PORT:5432" image'),
    ).toBe(false);
  });
});
