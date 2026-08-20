/**
 * Deterministic action/provider coverage for explicit-intent gates and the
 * fixed Omarchy command arguments; no real desktop command is executed.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { type CommandRunner, OmarchyBridge } from "../bridge.js";
import { createOmarchyDesktopActions } from "./desktop.js";

const runtime = {} as IAgentRuntime;

function message(text: string): Memory {
  return { content: { text } } as Memory;
}

function recordingBridge(): {
  bridge: OmarchyBridge;
  calls: Array<[string, readonly string[]]>;
} {
  const calls: Array<[string, readonly string[]]> = [];
  const run: CommandRunner = vi.fn(async (executable, args) => {
    calls.push([executable, args]);
    if (executable === "omarchy-version") {
      return { stdout: "1.2.3\n", stderr: "" };
    }
    if (executable === "omarchy-theme-current") {
      return { stdout: "Tokyo Night\n", stderr: "" };
    }
    if (executable === "omarchy-plugin-list") {
      return { stdout: "[]", stderr: "" };
    }
    return { stdout: "ok", stderr: "" };
  });
  return { bridge: new OmarchyBridge(run), calls };
}

describe("Omarchy desktop actions", () => {
  it("returns the read-only desktop snapshot", async () => {
    const { bridge } = recordingBridge();
    const [status] = createOmarchyDesktopActions(bridge, () => true);
    expect(status).toBeDefined();
    const result = await status?.handler(runtime, message("Omarchy status"));
    expect(result).toMatchObject({ success: true });
    expect(result?.text).toMatch(/Omarchy 1\.2\.3.*Tokyo Night/);
  });

  it("gates notifications on explicit request text", async () => {
    const { bridge } = recordingBridge();
    const notify = createOmarchyDesktopActions(bridge, () => true).find(
      (action) => action.name === "SHOW_OMARCHY_NOTIFICATION",
    );
    expect(notify).toBeDefined();
    await expect(notify?.validate(runtime, message("hello"))).resolves.toBe(
      false,
    );
    await expect(
      notify?.validate(runtime, message("show a desktop notification")),
    ).resolves.toBe(true);
  });

  it("sends validated notification parameters as data arguments", async () => {
    const { bridge, calls } = recordingBridge();
    const notify = createOmarchyDesktopActions(bridge, () => true).find(
      (action) => action.name === "SHOW_OMARCHY_NOTIFICATION",
    );
    const options = {
      parameters: {
        headline: "Build finished",
        body: "All focused tests passed.",
        urgency: "normal",
      },
    } as HandlerOptions;
    const result = await notify?.handler(
      runtime,
      message("notify me when the build finishes"),
      undefined,
      options,
    );
    expect(result).toMatchObject({ success: true });
    expect(calls).toContainEqual([
      "omarchy-notification-send",
      [
        "--app-name",
        "elizaos",
        "--urgency",
        "normal",
        "Build finished",
        "All focused tests passed.",
      ],
    ]);
  });

  it("summons only the Eliza pill on explicit request", async () => {
    const { bridge, calls } = recordingBridge();
    const showPill = createOmarchyDesktopActions(bridge, () => true).find(
      (action) => action.name === "SHOW_ELIZA_OMARCHY_PILL",
    );
    await expect(
      showPill?.validate(runtime, message("open the Eliza quick-chat pill")),
    ).resolves.toBe(true);
    const result = await showPill?.handler(
      runtime,
      message("open the Eliza quick-chat pill"),
    );
    expect(result).toMatchObject({ success: true });
    expect(calls).toContainEqual([
      "omarchy-shell",
      ["elizaos.eliza.bar", "show"],
    ]);
  });

  it("reports an IPC-level pill failure instead of claiming success", async () => {
    const run: CommandRunner = vi.fn(async () => ({
      stdout: "unknown\n",
      stderr: "",
    }));
    const showPill = createOmarchyDesktopActions(
      new OmarchyBridge(run),
      () => true,
    ).find((action) => action.name === "SHOW_ELIZA_OMARCHY_PILL");

    const result = await showPill?.handler(
      runtime,
      message("open the Eliza quick-chat pill"),
    );
    expect(result).toMatchObject({ success: false });
    expect(result?.text).toMatch(/could not open/);
  });
});
