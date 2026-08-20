/**
 * Deterministic unit coverage for the real Omarchy process-boundary contract;
 * the fake runner records exact executable/argument arrays and never invokes a
 * shell or touches the host desktop.
 */
import { describe, expect, it, vi } from "vitest";
import { type CommandRunner, isOmarchyHost, OmarchyBridge } from "./bridge.js";

function runnerWith(outputs: Record<string, string>): {
  run: CommandRunner;
  calls: Array<[string, readonly string[]]>;
} {
  const calls: Array<[string, readonly string[]]> = [];
  const run: CommandRunner = vi.fn(async (executable, args) => {
    calls.push([executable, args]);
    const stdout = outputs[executable];
    if (stdout === undefined) throw new Error(`missing ${executable}`);
    return { stdout, stderr: "" };
  });
  return { run, calls };
}

describe("OmarchyBridge", () => {
  it("reads version, theme, and validated plugin state through fixed binaries", async () => {
    const { run, calls } = runnerWith({
      "omarchy-version": "1.2.3\n",
      "omarchy-theme-current": "Tokyo Night\n",
      "omarchy-plugin-list": JSON.stringify([
        {
          id: "elizaos.eliza",
          enabled: true,
          firstParty: false,
          kinds: ["bar-widget", "panel"],
          name: "Eliza",
        },
      ]),
    });
    const snapshot = await new OmarchyBridge(run).snapshot();

    expect(snapshot).toMatchObject({
      available: true,
      version: "1.2.3",
      theme: "Tokyo Night",
      plugins: [{ id: "elizaos.eliza", enabled: true }],
    });
    expect(calls).toContainEqual(["omarchy-plugin-list", ["--json"]]);
  });

  it("returns an explicit unavailable state when Omarchy is absent", async () => {
    const run: CommandRunner = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    await expect(new OmarchyBridge(run).snapshot()).resolves.toMatchObject({
      available: false,
    });
  });

  it("fails closed when the theme or plugin inventory is unavailable", async () => {
    const themeMissing = runnerWith({
      "omarchy-version": "1.2.3\n",
      "omarchy-plugin-list": "[]",
    });
    await expect(
      new OmarchyBridge(themeMissing.run).snapshot(),
    ).resolves.toMatchObject({ available: false, version: "1.2.3" });

    const pluginsMissing = runnerWith({
      "omarchy-version": "1.2.3\n",
      "omarchy-theme-current": "Tokyo Night\n",
    });
    await expect(
      new OmarchyBridge(pluginsMissing.run).snapshot(),
    ).resolves.toMatchObject({
      available: false,
      version: "1.2.3",
      theme: "Tokyo Night",
    });
  });

  it("passes notification text only as argument slots", async () => {
    const { run, calls } = runnerWith({
      "omarchy-notification-send": "",
    });
    await new OmarchyBridge(run).notify(
      "Build finished",
      "The local test suite passed.",
      "normal",
    );
    expect(calls).toEqual([
      [
        "omarchy-notification-send",
        [
          "--app-name",
          "elizaos",
          "--urgency",
          "normal",
          "Build finished",
          "The local test suite passed.",
        ],
      ],
    ]);
  });

  it("rejects option-shaped notification content before process launch", async () => {
    const run: CommandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const bridge = new OmarchyBridge(run);
    await expect(
      bridge.notify("--exec", "do not run", "normal"),
    ).rejects.toThrow(/cannot start with a hyphen/);
    await expect(bridge.notify("Hello", "--exec", "normal")).rejects.toThrow(
      /cannot start with a hyphen/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the fixed bar IPC target to show the pill with effective settings", async () => {
    const { run, calls } = runnerWith({ "omarchy-shell": "ok" });
    await new OmarchyBridge(run).showElizaPill();
    expect(calls).toEqual([["omarchy-shell", ["elizaos.eliza.bar", "show"]]]);
  });

  it("rejects zero-exit IPC responses that did not open the pill", async () => {
    const { run } = runnerWith({ "omarchy-shell": "unknown\n" });
    await expect(new OmarchyBridge(run).showElizaPill()).rejects.toThrow(
      /could not open/,
    );
  });
});

describe("isOmarchyHost", () => {
  it("requires Linux plus the session path or installed package root", () => {
    expect(
      isOmarchyHost("darwin", { OMARCHY_PATH: "/opt/omarchy" }, () => true),
    ).toBe(false);
    expect(
      isOmarchyHost("linux", { OMARCHY_PATH: "/opt/omarchy" }, () => false),
    ).toBe(true);
    expect(
      isOmarchyHost("linux", {}, (path) => path === "/usr/share/omarchy"),
    ).toBe(true);
    expect(isOmarchyHost("linux", {}, () => false)).toBe(false);
  });
});
