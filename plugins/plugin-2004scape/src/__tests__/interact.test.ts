import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interact } from "../ui/TwoThousandFourScapeOperatorSurface.interact";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 202,
    json: async () => ({ success: true, message: "Queued." }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("2004scape TUI interact() capabilities", () => {
  it("terminal-2004scape-state returns the app metadata + command list", async () => {
    await expect(interact("terminal-2004scape-state")).resolves.toEqual({
      viewType: "tui",
      appName: "@elizaos/plugin-2004scape",
      commands: [
        "check status",
        "continue tutorial",
        "pause",
        "resume",
        "terminal-2004scape-command",
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("terminal-2004scape-command posts a message and returns the result", async () => {
    const result = (await interact("terminal-2004scape-command", {
      runId: "run-1",
      content: "chop nearby tree",
    })) as { viewType: string; command: { success: boolean } };

    expect(result.viewType).toBe("tui");
    expect(result.command).toEqual({ success: true, message: "Queued." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/apps/runs/run-1/message");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ content: "chop nearby tree" });
  });

  it("terminal-2004scape-command rejects missing runId / content", async () => {
    await expect(
      interact("terminal-2004scape-command", { content: "x" }),
    ).rejects.toThrow("runId is required");
    await expect(
      interact("terminal-2004scape-command", { runId: "run-1" }),
    ).rejects.toThrow("content is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("terminal-2004scape-pause posts a pause control action", async () => {
    const result = (await interact("terminal-2004scape-pause", {
      runId: "run-1",
    })) as { viewType: string; control: { success: boolean } };

    expect(result.viewType).toBe("tui");
    expect(result.control.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/apps/runs/run-1/control");
    expect(JSON.parse(init.body)).toEqual({ action: "pause" });
  });

  it("terminal-2004scape-resume posts a resume control action", async () => {
    await interact("terminal-2004scape-resume", { runId: "run-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/apps/runs/run-1/control");
    expect(JSON.parse(init.body)).toEqual({ action: "resume" });
  });

  it("terminal-2004scape-pause requires a runId", async () => {
    await expect(interact("terminal-2004scape-pause", {})).rejects.toThrow(
      "runId is required",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws for an unknown capability", async () => {
    await expect(interact("terminal-2004scape-unknown")).rejects.toThrow(
      "Unsupported 2004scape TUI capability: terminal-2004scape-unknown",
    );
  });
});
