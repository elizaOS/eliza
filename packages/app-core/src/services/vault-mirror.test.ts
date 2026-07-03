import { createTestVault, type TestVault } from "@elizaos/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetSharedVaultForTesting,
  sharedSecretsManager,
  sharedVault,
} from "./vault-mirror";

describe("vault-mirror shared vault facade", () => {
  const testVaults: TestVault[] = [];

  afterEach(async () => {
    _resetSharedVaultForTesting();
    await Promise.all(testVaults.splice(0).map((test) => test.dispose()));
  });

  async function createTrackedVault(): Promise<TestVault> {
    const test = await createTestVault();
    testVaults.push(test);
    return test;
  }

  it("memoizes the shared secrets manager and returns its vault", async () => {
    const test = await createTrackedVault();

    _resetSharedVaultForTesting(test.vault);

    const firstManager = sharedSecretsManager();
    expect(sharedSecretsManager()).toBe(firstManager);
    expect(sharedVault()).toBe(firstManager.vault);
    expect(sharedVault()).toBe(test.vault);
  });

  it("lets tests replace the cached vault facade", async () => {
    const first = await createTrackedVault();
    const second = await createTrackedVault();

    _resetSharedVaultForTesting(first.vault);
    const firstManager = sharedSecretsManager();

    _resetSharedVaultForTesting(second.vault);
    const secondManager = sharedSecretsManager();

    expect(secondManager).not.toBe(firstManager);
    expect(sharedVault()).toBe(second.vault);
  });
});
