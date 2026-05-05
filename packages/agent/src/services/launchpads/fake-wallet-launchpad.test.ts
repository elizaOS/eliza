import { describe, expect, it, vi } from "vitest";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../browser-workspace-types.js";
import { runLaunchpad } from "./launchpad-engine.js";
import type {
  LaunchpadProfile,
  LaunchpadTokenMetadata,
} from "./launchpad-types.js";

vi.mock("../browser-workspace.js", () => ({
  executeBrowserWorkspaceCommand: vi.fn(),
}));

import { executeBrowserWorkspaceCommand } from "../browser-workspace.js";

const mockExecute = vi.mocked(executeBrowserWorkspaceCommand);

const metadata: LaunchpadTokenMetadata = {
  name: "Fake Wallet Token",
  symbol: "FAKE",
  description: "Deterministic launchpad fixture for wallet boundary tests.",
  imageUrl: "fixture://fake-wallet-token.png",
  theme: "fake-wallet",
};

const fixtureProfile: LaunchpadProfile = {
  id: "fixture:fake-wallet",
  displayName: "Fake Wallet Launchpad",
  chain: "evm",
  entryUrl: "fixture://launchpad/create",
  network: { evmChainId: 97 },
  steps: [
    { kind: "navigate", url: "fixture://launchpad/create" },
    { kind: "waitFor", selector: "[data-fixture='create-form']" },
    {
      kind: "connectWallet",
      chain: "evm",
      connectButton: "[data-fixture='connect-wallet']",
      providerOption: "[data-wallet-provider='fake-wallet']",
    },
    {
      kind: "fillField",
      field: "name",
      selector: "[data-fixture='token-name']",
    },
    {
      kind: "fillField",
      field: "symbol",
      selector: "[data-fixture='token-symbol']",
    },
    {
      kind: "fillField",
      field: "description",
      selector: "[data-fixture='token-description']",
    },
    { kind: "uploadImage", selector: "[data-fixture='token-image']" },
    {
      kind: "click",
      text: "Launch",
      triggersTransaction: true,
      narration: "Submitting fake launch transaction",
    },
    { kind: "confirmTx", chain: "evm" },
    {
      kind: "awaitTxResult",
      explorerUrlPattern: "fixture://tx/fake-approved",
    },
  ],
};

type FakeWalletMode = "approve" | "reject";

interface FakeWalletRun {
  commands: BrowserWorkspaceCommand[];
  fields: Record<string, string>;
  providerOptionClicked: boolean;
  transactionClickCount: number;
  transactionApproved: boolean;
}

function installFakeWalletBridge(mode: FakeWalletMode): FakeWalletRun {
  const run: FakeWalletRun = {
    commands: [],
    fields: {},
    providerOptionClicked: false,
    transactionClickCount: 0,
    transactionApproved: false,
  };

  mockExecute.mockReset();
  mockExecute.mockImplementation(async (command) => {
    run.commands.push(command);

    if (command.subaction === "realistic-fill" && command.selector) {
      run.fields[command.selector] = String(command.value ?? "");
    }

    if (
      command.subaction === "realistic-click" &&
      command.selector === "[data-wallet-provider='fake-wallet']"
    ) {
      run.providerOptionClicked = true;
    }

    if (command.subaction === "realistic-click" && command.text === "Launch") {
      run.transactionClickCount += 1;
      if (!run.providerOptionClicked) {
        throw new Error("fake wallet provider option was not selected");
      }
      if (mode === "reject") {
        throw new Error("fake wallet rejected transaction");
      }
      run.transactionApproved = true;
    }

    if (
      command.subaction === "wait" &&
      command.text === "fixture://tx/fake-approved" &&
      !run.transactionApproved
    ) {
      throw new Error("fake transaction was not approved");
    }

    return {
      mode: "desktop",
      subaction: command.subaction,
    } satisfies BrowserWorkspaceCommandResult;
  });

  return run;
}

describe("fake wallet launchpad automation gate", () => {
  it("does not dispatch the transaction-triggering click in dryRun stop-before-tx mode", async () => {
    const fakeRun = installFakeWalletBridge("approve");

    const result = await runLaunchpad(fixtureProfile, {
      tabId: "fake-wallet-tab",
      metadata,
      narrate: () => undefined,
      dryRun: "stop-before-tx",
      maxRetries: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "dry-run stopped before transaction",
      stoppedAtStep: 7,
    });
    expect(fakeRun.transactionClickCount).toBe(0);
    expect(
      fakeRun.commands.some(
        (command) =>
          command.subaction === "realistic-click" && command.text === "Launch",
      ),
    ).toBe(false);
  });

  it("clicks providerOption before the fake wallet transaction boundary", async () => {
    const fakeRun = installFakeWalletBridge("approve");

    const result = await runLaunchpad(fixtureProfile, {
      tabId: "fake-wallet-tab",
      metadata,
      narrate: () => undefined,
      maxRetries: 0,
    });

    expect(result.ok).toBe(true);
    expect(fakeRun.providerOptionClicked).toBe(true);

    const providerOptionIndex = fakeRun.commands.findIndex(
      (command) =>
        command.subaction === "realistic-click" &&
        command.selector === "[data-wallet-provider='fake-wallet']",
    );
    const transactionClickIndex = fakeRun.commands.findIndex(
      (command) =>
        command.subaction === "realistic-click" && command.text === "Launch",
    );

    expect(providerOptionIndex).toBeGreaterThan(-1);
    expect(transactionClickIndex).toBeGreaterThan(providerOptionIndex);
  });

  it("completes the fake wallet approve branch through transaction result wait", async () => {
    const fakeRun = installFakeWalletBridge("approve");

    const result = await runLaunchpad(fixtureProfile, {
      tabId: "fake-wallet-tab",
      metadata,
      narrate: () => undefined,
      maxRetries: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      reason: "completed",
      stoppedAtStep: fixtureProfile.steps.length - 1,
    });
    expect(fakeRun.transactionClickCount).toBe(1);
    expect(fakeRun.transactionApproved).toBe(true);
    expect(fakeRun.fields["[data-fixture='token-name']"]).toBe(metadata.name);
    expect(fakeRun.fields["[data-fixture='token-symbol']"]).toBe(
      metadata.symbol,
    );
  });

  it("fails deterministically when the fake wallet rejects at transaction step", async () => {
    const fakeRun = installFakeWalletBridge("reject");
    const narrated: string[] = [];

    const result = await runLaunchpad(fixtureProfile, {
      tabId: "fake-wallet-tab",
      metadata,
      narrate: (line) => {
        narrated.push(line);
      },
      maxRetries: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "fake wallet rejected transaction",
      stoppedAtStep: 7,
    });
    expect(fakeRun.transactionClickCount).toBe(1);
    expect(fakeRun.transactionApproved).toBe(false);
    expect(narrated.at(-1)).toMatch(/fake wallet rejected transaction/);
  });
});
