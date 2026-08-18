import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpService,
  buildCodingBaselineMetadata,
} from "../../src/services/acp-service.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function runtime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: () => null,
    services: new Map(),
  } as unknown as IAgentRuntime;
}

describe("AcpService session-private Git index", () => {
  it("persists dirty path fingerprints for an unborn repository with no HEAD", () => {
    const fingerprint = {
      path: "preserve-untracked.txt",
      kind: "file" as const,
      mode: 0o644,
      sha256: "a".repeat(64),
    };

    expect(
      buildCodingBaselineMetadata(
        undefined,
        [],
        ["preserve-untracked.txt"],
        [fingerprint],
      ),
    ).toEqual({
      codingBaselineUntracked: ["preserve-untracked.txt"],
      codingBaselinePathFingerprints: [fingerprint],
    });
  });

  it("initializes a valid private index for an unborn repository without creating the operator index", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-acp-unborn-index-"));
    cleanup.push(fixture);
    const workdir = join(fixture, "workspace");
    expect(
      spawnSync("git", ["init", "-b", "main", workdir], {
        encoding: "utf8",
      }).status,
    ).toBe(0);
    const operatorIndex = join(workdir, ".git", "index");
    expect(existsSync(operatorIndex)).toBe(false);

    const service = new AcpService(runtime());
    const prepared = await (
      service as unknown as {
        prepareSessionGitIndex: (
          workdir: string,
          sessionId: string,
          baselineSha?: string,
        ) => Promise<
          | { env: Record<string, string>; metadata: Record<string, string> }
          | undefined
        >;
      }
    ).prepareSessionGitIndex(workdir, randomUUID());

    expect(prepared).toBeDefined();
    const privateIndex = prepared?.env.GIT_INDEX_FILE;
    expect(privateIndex).toBeTruthy();
    expect(existsSync(privateIndex ?? "")).toBe(true);
    expect(readFileSync(privateIndex ?? "").length).toBeGreaterThan(0);
    expect(existsSync(operatorIndex)).toBe(false);
    if (privateIndex) cleanup.push(dirname(privateIndex));

    const status = spawnSync("git", ["-C", workdir, "status", "--short"], {
      env: { ...process.env, GIT_INDEX_FILE: privateIndex },
      encoding: "utf8",
    });
    expect(status.status, status.stderr).toBe(0);
  });
});
