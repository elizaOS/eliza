import { afterEach, describe, expect, it } from "vitest";
import {
  clearPasswordManagerBackendCache,
  detectPasswordManagerBackend,
  injectCredentialToClipboard,
  listPasswordItems,
  searchPasswordItems,
} from "./password-manager-bridge.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearPasswordManagerBackendCache();
});

describe("password-manager bridge", () => {
  it("uses the fixture backend when explicitly enabled", async () => {
    process.env.ELIZA_TEST_PASSWORD_MANAGER_BACKEND = "1";
    clearPasswordManagerBackendCache();

    await expect(detectPasswordManagerBackend()).resolves.toBe("fixture");
    await expect(listPasswordItems({ limit: 2 })).resolves.toHaveLength(2);
    await expect(searchPasswordItems("github")).resolves.toMatchObject([
      {
        id: "pm-github",
        title: "GitHub",
        hasPassword: true,
      },
    ]);
  });

  it("does not write real clipboard contents in fixture mode", async () => {
    process.env.ELIZA_TEST_PASSWORD_MANAGER_BACKEND = "1";
    clearPasswordManagerBackendCache();

    await expect(
      injectCredentialToClipboard("pm-github", "password"),
    ).resolves.toEqual({
      ok: true,
      expiresInSeconds: 30,
      fixtureMode: true,
    });
  });

  it("honors explicit none backend", async () => {
    await expect(
      detectPasswordManagerBackend({ preferredBackend: "none" }),
    ).resolves.toBe("none");
  });
});
