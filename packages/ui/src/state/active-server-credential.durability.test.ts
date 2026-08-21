/** Verifies that paired credentials reach durable native storage before callers continue. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveProfile: vi.fn(),
  loadPersistedActiveServer: vi.fn(),
  savePersistedActiveServer: vi.fn(),
  setStorageValue: vi.fn(),
  updateAgentProfile: vi.fn(),
}));

vi.mock("./agent-profiles", () => ({
  getActiveProfile: mocks.getActiveProfile,
  updateAgentProfile: mocks.updateAgentProfile,
}));

vi.mock("./persistence", () => ({
  loadPersistedActiveServer: mocks.loadPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
}));

vi.mock("../bridge/storage-bridge", () => ({
  setStorageValue: mocks.setStorageValue,
}));

import { persistActiveServerCredential } from "./active-server-credential";

describe("persistActiveServerCredential native durability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPersistedActiveServer.mockReturnValue({
      id: "remote:test",
      kind: "remote",
      label: "Test runtime",
      apiBase: "https://runtime.example.test",
    });
    mocks.getActiveProfile.mockReturnValue(null);
  });

  it("does not resolve until the active-server mirror is durable", async () => {
    let releaseWrite!: () => void;
    mocks.setStorageValue.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );

    let completed = false;
    const persistence = persistActiveServerCredential("paired-token").then(
      () => {
        completed = true;
      },
    );
    await Promise.resolve();

    const authenticatedServer = {
      id: "remote:test",
      kind: "remote",
      label: "Test runtime",
      apiBase: "https://runtime.example.test",
      accessToken: "paired-token",
    };
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      authenticatedServer,
    );
    expect(mocks.setStorageValue).toHaveBeenCalledWith(
      "elizaos:active-server",
      JSON.stringify(authenticatedServer),
    );
    expect(completed).toBe(false);

    releaseWrite();
    await persistence;
    expect(completed).toBe(true);
  });
});
