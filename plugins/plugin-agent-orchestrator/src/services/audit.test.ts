import { beforeEach, describe, expect, it, vi } from "vitest";

const fsPromisesMock = vi.hoisted(() => ({
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  stat: vi.fn(),
}));

const osMock = vi.hoisted(() => ({
  homedir: vi.fn(() => "/home/tester"),
}));

vi.mock("node:fs/promises", () => ({
  default: fsPromisesMock,
  ...fsPromisesMock,
}));
vi.mock("node:os", () => ({ default: osMock, homedir: osMock.homedir }));
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { default: actual, ...actual };
});

import {
  appendAuditLine,
  defaultAuditLogPath,
  emitTaskAudit,
  TASK_AUDIT_EVENT,
} from "./audit";

const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "spawn_agent",
    outcome: "allowed",
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("orchestrator audit log", () => {
  beforeEach(() => {
    fsPromisesMock.appendFile.mockClear();
    fsPromisesMock.mkdir.mockClear();
    fsPromisesMock.rename.mockClear();
    fsPromisesMock.stat.mockReset();
    osMock.homedir.mockReturnValue("/home/tester");
  });

  it("defaultAuditLogPath is under the home dir with the plugin path", () => {
    expect(defaultAuditLogPath()).toBe(
      "/home/tester/.eliza/plugin-acp/audit.ndjson",
    );
    expect(osMock.homedir).toHaveBeenCalled();
  });

  it("appendAuditLine creates the parent directory recursively", async () => {
    await appendAuditLine("/logs/audit.ndjson", payload());
    expect(fsPromisesMock.mkdir).toHaveBeenCalledWith("/logs", {
      recursive: true,
    });
  });

  it("appendAuditLine writes one NDJSON line per payload", async () => {
    await appendAuditLine(
      "/logs/audit.ndjson",
      payload({ outcome: "forbidden" }),
    );
    const arg = fsPromisesMock.appendFile.mock.calls[0];
    expect(arg[0]).toBe("/logs/audit.ndjson");
    expect(arg[2]).toBe("utf8");
    const line = JSON.parse(arg[1] as string);
    expect(line.action).toBe("spawn_agent");
    expect(line.outcome).toBe("forbidden");
    expect((arg[1] as string).endsWith("\n")).toBe(true);
  });

  it("rotates the log to .1 once it crosses the byte cap, then appends", async () => {
    fsPromisesMock.stat.mockResolvedValue({ size: AUDIT_LOG_MAX_BYTES });
    await appendAuditLine("/logs/audit.ndjson", payload());
    expect(fsPromisesMock.rename).toHaveBeenCalledWith(
      "/logs/audit.ndjson",
      "/logs/audit.ndjson.1",
    );
    expect(fsPromisesMock.appendFile).toHaveBeenCalledTimes(1);
  });

  it("does not rotate while the log is below the cap", async () => {
    fsPromisesMock.stat.mockResolvedValue({
      size: AUDIT_LOG_MAX_BYTES - 1,
    });
    await appendAuditLine("/logs/audit.ndjson", payload());
    expect(fsPromisesMock.rename).not.toHaveBeenCalled();
    expect(fsPromisesMock.appendFile).toHaveBeenCalledTimes(1);
  });

  it("treats a missing log file as absent — no rotation, first append creates it", async () => {
    fsPromisesMock.stat.mockRejectedValue(new Error("ENOENT"));
    await expect(
      appendAuditLine("/logs/audit.ndjson", payload()),
    ).resolves.toBeUndefined();
    expect(fsPromisesMock.rename).not.toHaveBeenCalled();
    expect(fsPromisesMock.appendFile).toHaveBeenCalledTimes(1);
  });

  it("degrades to unrotated append when rotation fails — growth beats losing audit entries", async () => {
    fsPromisesMock.stat.mockResolvedValue({ size: AUDIT_LOG_MAX_BYTES });
    fsPromisesMock.rename.mockRejectedValue(new Error("EPERM"));
    await expect(
      appendAuditLine("/logs/audit.ndjson", payload()),
    ).resolves.toBeUndefined();
    expect(fsPromisesMock.appendFile).toHaveBeenCalledTimes(1);
  });

  it("emits the audit event with a timestamp envelope", async () => {
    const runtime = { emitEvent: vi.fn(async () => undefined) };
    await emitTaskAudit(runtime as never, payload({ action: "cancel_agent" }));
    expect(runtime.emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, envelope] = runtime.emitEvent.mock.calls[0];
    expect(eventName).toBe(TASK_AUDIT_EVENT);
    expect(envelope.action).toBe("cancel_agent");
    expect(envelope.outcome).toBe("allowed");
    expect(envelope.runtime).toBe(runtime);
    expect(typeof envelope.ts).toBe("string");
    expect(Date.parse(envelope.ts)).not.toBeNaN();
  });

  it("surfaces a dropped audit event observably instead of swallowing or throwing", async () => {
    const boom = new Error("event bus down");
    const reportError = vi.fn();
    const runtime = {
      emitEvent: vi.fn(async () => {
        throw boom;
      }),
      reportError,
    };
    await expect(
      emitTaskAudit(runtime as never, payload({ source: "runner" })),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0]).toBe("[emitTaskAudit]");
    expect(reportError.mock.calls[0][1]).toBe(boom);
    expect(reportError.mock.calls[0][2]).toMatchObject({
      action: "spawn_agent",
      outcome: "allowed",
      source: "runner",
    });
  });
});
