import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeploy } from "./deploy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("runDeploy", () => {
  it("prints a deployment plan and exits successfully by default", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const code = runDeploy({
      appId: "app-123",
      domain: "agent.example.com",
    });

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("elizaos deploy");
    expect(output).toContain("deployment plan");
    expect(output).toContain("app-123");
    expect(output).toContain("agent.example.com");
  });

  it("accepts dryRun for compatibility without changing behavior", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runDeploy({ dryRun: true });

    expect(code).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "No network calls, filesystem writes, or builds are performed.",
    );
  });

  it("rejects invalid domains before printing the plan", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runDeploy({ domain: "not a hostname" });

    expect(code).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).toContain("Invalid --domain");
  });
});
