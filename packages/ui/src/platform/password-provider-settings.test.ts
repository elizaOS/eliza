/** Provider destinations remain local preferences, validated again after persistence. */
// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../bridge/storage-bridge", () => ({
  getStorageValue: storage.get,
  setStorageValue: storage.set,
}));

import {
  defaultPasswordProviderSettings,
  loadPasswordProviderSettings,
  savePasswordProviderSettings,
  validatePasswordProviderUrl,
} from "./password-provider-settings";

beforeEach(() => {
  vi.resetAllMocks();
  storage.get.mockResolvedValue(null);
});

it("remembers separate provider destinations through the local settings bridge", async () => {
  const settings = defaultPasswordProviderSettings();
  settings.provider = "1password";
  settings.webVaults.bitwarden = "https://vault.example.test/team/";
  settings.webVaults["1password"] = "https://my.1password.eu/";
  await savePasswordProviderSettings(settings);
  expect(storage.set).toHaveBeenCalledWith(
    "eliza.browser.password-provider.v1",
    JSON.stringify(settings),
  );
  storage.get.mockResolvedValue(storage.set.mock.calls[0][1]);
  expect(await loadPasswordProviderSettings()).toEqual(settings);
});

it.each([
  "http://vault.example.test/",
  "https://user:secret@vault.example.test/",
  "https://vault.example.test/?token=secret",
  "https://vault.example.test/#secret",
  "javascript:alert(1)",
  "file:///tmp/vault",
  "not a URL",
])("rejects a non-secret-free HTTPS destination: %s", (url) => {
  expect(() => validatePasswordProviderUrl("bitwarden", url)).toThrow();
});

it.each([
  "https://my.1password.com.attacker.test/",
  "https://fake1password.com/",
  "https://my.1password.ca:8443/",
])("rejects an unofficial 1Password account address: %s", (url) => {
  expect(() => validatePasswordProviderUrl("1password", url)).toThrow();
});

it("supports all official 1Password regions and named team accounts", () => {
  for (const region of ["com", "eu", "ca"]) {
    expect(
      validatePasswordProviderUrl(
        "1password",
        `https://my.1password.${region}`,
      ),
    ).toBe(`https://my.1password.${region}/`);
    expect(
      validatePasswordProviderUrl(
        "1password",
        `https://our-team.1password.${region}`,
      ),
    ).toBe(`https://our-team.1password.${region}/`);
  }
});

it("does not silently replace a malformed saved destination with a default", async () => {
  const settings = defaultPasswordProviderSettings();
  settings.webVaults.bitwarden = "https://vault.example.test/?password=fixture";
  storage.get.mockResolvedValue(JSON.stringify(settings));
  await expect(loadPasswordProviderSettings()).rejects.toThrow();
  expect(storage.set).not.toHaveBeenCalled();
});

it("propagates persistence failure and rejects invalid writes", async () => {
  storage.set.mockRejectedValue(new Error("storage unavailable"));
  await expect(
    savePasswordProviderSettings(defaultPasswordProviderSettings()),
  ).rejects.toThrow("storage unavailable");
  storage.set.mockClear();
  const settings = defaultPasswordProviderSettings();
  settings.webVaults.bitwarden = "http://vault.example.test/";
  await expect(savePasswordProviderSettings(settings)).rejects.toThrow();
  expect(storage.set).not.toHaveBeenCalled();
});
