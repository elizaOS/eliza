import { describe, expect, it } from "vitest";
import { buildUpdateCommand, getUpdateActionPlan } from "./self-updater.ts";

describe("self-updater command mapping", () => {
  it.each([
    ["npm-global", "stable", "npm install -g elizaos@latest"],
    ["bun-global", "beta", "bun install -g elizaos@beta"],
    ["homebrew", "nightly", "brew upgrade eliza"],
    ["snap", "nightly", "sudo snap refresh eliza --channel=edge"],
    [
      "apt",
      "stable",
      "sudo apt-get update && sudo apt-get install --only-upgrade -y eliza",
    ],
    ["flatpak", "beta", "flatpak update ai.eliza.Eliza"],
    ["unknown", "nightly", "npm install -g elizaos@nightly"],
  ] as const)("builds a display command for %s on %s", (method, channel, expected) => {
    expect(buildUpdateCommand(method, channel)?.displayCommand).toBe(expected);
  });

  it("does not build an executable command for local development installs", () => {
    expect(buildUpdateCommand("local-dev", "stable")).toBeNull();
  });
});

describe("self-updater action plan", () => {
  it.each([
    ["npm-global", "package-manager", "run-package-manager-command", true],
    ["bun-global", "package-manager", "run-package-manager-command", true],
    ["homebrew", "package-manager", "run-package-manager-command", true],
    ["apt", "os-package-manager", "run-package-manager-command", true],
    ["snap", "os-package-manager", "run-package-manager-command", true],
    ["flatpak", "os-package-manager", "run-package-manager-command", true],
    ["local-dev", "developer", "run-git-pull", false],
    ["unknown", "operator", "review-installation", true],
  ] as const)("maps %s to authority and next action", (method, authority, nextAction, canAutoUpdate) => {
    const plan = getUpdateActionPlan(method, "stable");

    expect(plan.authority).toBe(authority);
    expect(plan.nextAction).toBe(nextAction);
    expect(plan.canAutoUpdate).toBe(canAutoUpdate);
    expect(plan.canExecuteFromContext).toBe(canAutoUpdate);
  });

  it("marks remote status views as display-only", () => {
    const plan = getUpdateActionPlan("apt", "stable", {
      remoteDisplay: true,
    });

    expect(plan.remoteDisplay).toBe(true);
    expect(plan.canAutoUpdate).toBe(true);
    expect(plan.canExecuteFromContext).toBe(false);
    expect(plan.command).toBe(
      "sudo apt-get update && sudo apt-get install --only-upgrade -y eliza",
    );
    expect(plan.message).toContain("no remote execution endpoint");
  });

  it("gives local development installs a git-only next action", () => {
    const plan = getUpdateActionPlan("local-dev", "nightly");

    expect(plan.command).toBe("git pull");
    expect(plan.canAutoUpdate).toBe(false);
    expect(plan.canExecuteFromContext).toBe(false);
    expect(plan.message).toContain("git pull");
  });
});
