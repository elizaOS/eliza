import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetCapabilityBrokerForTests,
  type AuditedDecision,
  CapabilityBroker,
  getCapabilityBroker,
} from "./capability-broker.ts";

function mkTmpStateDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "capability-broker-"));
}

function readAuditLines(file: string): AuditedDecision[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as AuditedDecision);
}

describe("CapabilityBroker", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkTmpStateDir();
    __resetCapabilityBrokerForTests();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    __resetCapabilityBrokerForTests();
  });

  it("denies fs.write on host paths in cloud mode and allows allowlisted net.connect", () => {
    const broker = new CapabilityBroker({
      stateDir,
      mode: () => "cloud",
      distributionProfile: () => "unrestricted",
    });

    const fsWrite = broker.check({
      kind: "fs",
      op: "write",
      target: "/Users/me/secrets.txt",
    });
    expect(fsWrite.allowed).toBe(false);
    if (fsWrite.allowed === false) {
      expect(fsWrite.reason).toMatch(/host filesystem/i);
    }

    const cloudConnect = broker.check({
      kind: "net",
      op: "connect",
      target: "https://api.elizacloud.ai/v1/inference",
    });
    expect(cloudConnect.allowed).toBe(true);

    const arbitraryConnect = broker.check({
      kind: "net",
      op: "connect",
      target: "https://attacker.example.com/exfil",
    });
    expect(arbitraryConnect.allowed).toBe(false);
  });

  it("local-yolo + unrestricted allows shell.exec without a sandbox prefix", () => {
    const broker = new CapabilityBroker({
      stateDir,
      mode: () => "local-yolo",
      distributionProfile: () => "unrestricted",
    });

    const decision = broker.check({
      kind: "shell",
      op: "exec",
      toolName: "bash.run",
      target: "ls -al",
    });
    expect(decision.allowed).toBe(true);
  });

  it("local-safe denies shell.exec at host but allows it through sandbox.* tools", () => {
    const broker = new CapabilityBroker({
      stateDir,
      mode: () => "local-safe",
      distributionProfile: () => "unrestricted",
    });

    const hostShell = broker.check({
      kind: "shell",
      op: "exec",
      toolName: "bash.run",
      target: "ls /",
    });
    expect(hostShell.allowed).toBe(false);

    const sandboxShell = broker.check({
      kind: "shell",
      op: "exec",
      toolName: "sandbox.exec",
      target: "ls /",
    });
    expect(sandboxShell.allowed).toBe(true);
  });

  it("store profile + local-yolo still denies fs.write outside VFS", () => {
    const broker = new CapabilityBroker({
      stateDir,
      mode: () => "local-yolo",
      distributionProfile: () => "store",
    });

    const hostWrite = broker.check({
      kind: "fs",
      op: "write",
      target: "/Users/me/Documents/file.txt",
    });
    expect(hostWrite.allowed).toBe(false);

    const vfsWrite = broker.check({
      kind: "fs",
      op: "write",
      target: "vfs://my-project/notes.md",
    });
    expect(vfsWrite.allowed).toBe(true);
  });

  it("audit log has one JSONL line per check and parses cleanly", () => {
    const auditFilePath = path.join(stateDir, "audit", "capability.jsonl");
    const broker = new CapabilityBroker({
      stateDir,
      auditFilePath,
      mode: () => "local-safe",
      distributionProfile: () => "unrestricted",
    });

    broker.check({ kind: "net", op: "connect", target: "https://x.com" });
    broker.check({
      kind: "shell",
      op: "exec",
      toolName: "bash.run",
      target: "echo 1",
    });
    broker.check({
      kind: "shell",
      op: "exec",
      toolName: "sandbox.exec",
      target: "echo 1",
    });

    const lines = readAuditLines(auditFilePath);
    expect(lines).toHaveLength(3);
    expect(lines[0].kind).toBe("net");
    expect(lines[0].allowed).toBe(true);
    expect(lines[1].kind).toBe("shell");
    expect(lines[1].allowed).toBe(false);
    expect(lines[1].denyReason).toMatch(/sandbox/i);
    expect(lines[2].allowed).toBe(true);
    for (const line of lines) {
      expect(line.mode).toBe("local-safe");
      expect(line.profile).toBe("unrestricted");
      expect(typeof line.policyKey).toBe("string");
      expect(typeof line.ts).toBe("string");
    }
  });

  it("recentDecisions(n) returns last n entries", () => {
    const broker = new CapabilityBroker({
      stateDir,
      mode: () => "local-yolo",
      distributionProfile: () => "unrestricted",
    });

    for (let i = 0; i < 15; i += 1) {
      broker.check({
        kind: "fs",
        op: "read",
        target: `/tmp/x${i}`,
        toolName: "fs.read",
      });
    }

    const last10 = broker.recentDecisions(10);
    expect(last10).toHaveLength(10);
    expect(last10[0].target).toBe("/tmp/x5");
    expect(last10[9].target).toBe("/tmp/x14");

    const snapshot = broker.snapshot();
    expect(snapshot.mode).toBe("local-yolo");
    expect(snapshot.profile).toBe("unrestricted");
    expect(snapshot.recent.length).toBeGreaterThanOrEqual(10);
  });

  it("truncates the audit log when it exceeds 50 MB at boot", () => {
    const auditFilePath = path.join(stateDir, "audit", "capability.jsonl");
    // First broker just to ensure the audit dir exists.
    new CapabilityBroker({
      stateDir,
      auditFilePath,
      mode: () => "local-safe",
      distributionProfile: () => "unrestricted",
    });
    const oversize = Buffer.alloc(51 * 1024 * 1024, "a");
    writeFileSync(auditFilePath, oversize);
    expect(statSync(auditFilePath).size).toBeGreaterThan(50 * 1024 * 1024);

    new CapabilityBroker({
      stateDir,
      auditFilePath,
      mode: () => "local-safe",
      distributionProfile: () => "unrestricted",
    });
    expect(statSync(auditFilePath).size).toBe(0);
  });

  it("getCapabilityBroker returns a cached singleton", () => {
    const a = getCapabilityBroker();
    const b = getCapabilityBroker();
    expect(a).toBe(b);
  });
});
