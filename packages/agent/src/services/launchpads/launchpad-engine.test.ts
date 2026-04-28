/**
 * Engine verification: profile-driven runner produces the right
 * BrowserWorkspaceCommand sequence, narrates each step, retries on
 * recoverable errors, and respects dryRun stop-before-tx.
 *
 * This exercises the engine against a stub bridge (no real browser),
 * which is the highest-fidelity verification we can run in CI without
 * loading four.meme / flap.sh live.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../browser-workspace-types.js";
import { runLaunchpad } from "./launchpad-engine.js";
import type { LaunchpadProfile } from "./launchpad-types.js";

vi.mock("../browser-workspace.js", () => ({
  executeBrowserWorkspaceCommand: vi.fn(),
}));

import { executeBrowserWorkspaceCommand } from "../browser-workspace.js";

const mockExecute = vi.mocked(executeBrowserWorkspaceCommand);

const sampleProfile: LaunchpadProfile = {
  id: "test:sample",
  displayName: "Sample",
  chain: "evm",
  entryUrl: "https://example.com",
  network: { evmChainId: 56 },
  steps: [
    { kind: "navigate", url: "https://example.com" },
    { kind: "fillField", field: "name", selector: "input[name=name]" },
    { kind: "fillField", field: "symbol", selector: "input[name=symbol]" },
    { kind: "fillField", field: "description", selector: "textarea" },
    { kind: "uploadImage", selector: "input[type=file]" },
    { kind: "click", text: "Launch" },
    { kind: "confirmTx", chain: "evm" },
    { kind: "awaitTxResult", explorerUrlPattern: "bscscan.com" },
  ],
};

const sampleMetadata = {
  name: "Test Token",
  symbol: "TEST",
  description: "A test token used by the engine smoke suite.",
  imageUrl: "https://picsum.photos/seed/TEST/1024/1024",
  theme: "test",
};

function okResult(): BrowserWorkspaceCommandResult {
  return { mode: "desktop", subaction: "click" };
}

describe("runLaunchpad", () => {
  it("emits one narration per step and dispatches commands in order", async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(okResult());
    const narrated: string[] = [];
    const commands: BrowserWorkspaceCommand[] = [];
    mockExecute.mockImplementation(async (cmd) => {
      commands.push(cmd);
      return okResult();
    });
    const narrate = (line: string) => {
      narrated.push(line);
    };

    const result = await runLaunchpad(sampleProfile, {
      tabId: "btab_1",
      metadata: sampleMetadata,
      narrate,
    });

    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("test:sample");

    // Each non-confirmTx step dispatches exactly one command — confirmTx is
    // a narration-only pause.
    const dispatchedKinds = sampleProfile.steps.filter(
      (s) => s.kind !== "confirmTx",
    ).length;
    expect(commands.length).toBe(dispatchedKinds);

    // Narration fires for every step (including confirmTx), in order.
    expect(narrated.length).toBe(sampleProfile.steps.length);

    // The first dispatched command is a navigate to the profile URL.
    expect(commands[0]).toMatchObject({
      subaction: "navigate",
      url: "https://example.com",
    });

    // Field fills use realistic-fill with the metadata value.
    const nameFill = commands.find(
      (c) =>
        c.subaction === "realistic-fill" &&
        c.selector === "input[name=name]",
    );
    expect(nameFill?.value).toBe("Test Token");

    const symbolFill = commands.find(
      (c) =>
        c.subaction === "realistic-fill" &&
        c.selector === "input[name=symbol]",
    );
    expect(symbolFill?.value).toBe("TEST");

    // Upload uses realistic-upload pointing at the metadata imageUrl.
    const upload = commands.find((c) => c.subaction === "realistic-upload");
    expect(upload?.files?.[0]).toBe(sampleMetadata.imageUrl);

    // Click step uses realistic-click against the Launch text.
    const click = commands.find(
      (c) => c.subaction === "realistic-click" && c.text === "Launch",
    );
    expect(click).toBeDefined();
  });

  it("stops before submission in dryRun stop-before-tx mode", async () => {
    mockExecute.mockReset();
    mockExecute.mockResolvedValue(okResult());
    const narrated: string[] = [];
    const result = await runLaunchpad(sampleProfile, {
      tabId: "btab_1",
      metadata: sampleMetadata,
      narrate: (line) => {
        narrated.push(line);
      },
      dryRun: "stop-before-tx",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/dry-run/i);
    // confirmTx is the 7th step (index 6); the engine stops there.
    expect(result.stoppedAtStep).toBe(6);
    // The dry-run narration line is appended.
    const last = narrated[narrated.length - 1];
    expect(last).toMatch(/dry-run/i);
  });

  it("retries recoverable errors and surfaces fatal ones", async () => {
    mockExecute.mockReset();
    let attempts = 0;
    mockExecute.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("Target element was not found.");
      }
      return okResult();
    });

    const minimalProfile: LaunchpadProfile = {
      ...sampleProfile,
      steps: [{ kind: "click", selector: ".x" }],
    };
    const result = await runLaunchpad(minimalProfile, {
      tabId: "t",
      metadata: sampleMetadata,
      narrate: () => undefined,
      maxRetries: 3,
    });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);

    mockExecute.mockReset();
    mockExecute.mockImplementation(async () => {
      throw new Error("a totally fatal non-retry error");
    });
    const failResult = await runLaunchpad(minimalProfile, {
      tabId: "t",
      metadata: sampleMetadata,
      narrate: () => undefined,
      maxRetries: 3,
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.reason).toMatch(/fatal/);
  });
});
