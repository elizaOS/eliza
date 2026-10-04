import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveElizaConfig } from "../src/config/config.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function destination() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "external-config-"));
  directories.push(directory);
  const file = path.join(directory, "config.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", file);
  return file;
}
it("persists ordinary settings without hydrated external credentials and preserves in-memory input", () => {
  const file = destination();
  const key = "fixture-host-held-cloud-secret";
  vi.stubEnv(
    "ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS",
    "EXTERNAL_CLOUD_TEST_KEY",
  );
  vi.stubEnv("EXTERNAL_CLOUD_TEST_KEY", key);
  const config = {
    cloud: { enabled: true, apiKey: key },
    env: { vars: { EXTERNAL_CLOUD_TEST_KEY: key, ORDINARY_SETTING: "kept" } },
  };
  saveElizaConfig(config);
  const bytes = fs.readFileSync(file, "utf8");
  expect(bytes).not.toContain(key);
  expect(JSON.parse(bytes).cloud.enabled).toBe(true);
  expect(JSON.parse(bytes).env.vars.ORDINARY_SETTING).toBe("kept");
  expect(config.cloud.apiKey).toBe(key);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  saveElizaConfig(config);
  expect(fs.readFileSync(file, "utf8")).not.toContain(key);
});
it("leaves unselected credentials unchanged and rejects malformed policy before replacing a file", () => {
  const file = destination();
  vi.stubEnv("ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "");
  saveElizaConfig({ cloud: { apiKey: "fixture-legacy-key" } });
  const before = fs.readFileSync(file, "utf8");
  expect(before).toContain("fixture-legacy-key");
  vi.stubEnv("ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "BAD NAME");
  expect(() => saveElizaConfig({ cloud: { apiKey: "replacement" } })).toThrow(
    "Invalid external config secret policy",
  );
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

it("preserves saved and explicit connector options when legacy credentials are persisted", async () => {
  const file = destination();
  const { prepareFirstRunConnectors } = await import(
    "../src/first-run-config.ts"
  );
  const { loadElizaConfig } = await import("../src/config/config.ts");
  const prepared = prepareFirstRunConnectors(
    {
      connectors: {
        telegram: { enabled: false, botToken: "old-telegram" },
        discord: { enabled: false, token: "old-discord" },
        whatsapp: { enabled: false, sessionPath: "/old/session" },
      },
    },
    {
      connectors: { telegram: { groupPolicy: "allowlist" } },
      telegramToken: "new-telegram",
      discordToken: "new-discord",
      whatsappSessionPath: "/new/session",
    },
  );
  if (!prepared.ok) throw new Error(prepared.error);
  saveElizaConfig({ connectors: prepared.connectors });
  expect(fs.existsSync(file)).toBe(true);
  expect(loadElizaConfig().connectors).toMatchObject({
    telegram: {
      enabled: false,
      botToken: "new-telegram",
      groupPolicy: "allowlist",
    },
    discord: { enabled: false, token: "new-discord" },
    whatsapp: { enabled: false, sessionPath: "/new/session" },
  });
});

it("keeps unavailable owner configuration distinct from an unset name", async () => {
  const file = destination();
  const { fetchConfiguredOwnerName, persistConfiguredOwnerName } = await import(
    "../src/services/owner-name.ts"
  );
  expect(await fetchConfiguredOwnerName()).toBeNull();
  expect(await persistConfiguredOwnerName("  Owner  ")).toBe(true);
  expect(await fetchConfiguredOwnerName()).toBe("Owner");
  fs.writeFileSync(file, "{broken");
  await expect(fetchConfiguredOwnerName()).rejects.toMatchObject({
    code: "OWNER_NAME_READ_FAILED",
  });
  await expect(persistConfiguredOwnerName("Replacement")).rejects.toMatchObject(
    { code: "OWNER_NAME_WRITE_FAILED" },
  );
  expect(fs.readFileSync(file, "utf8")).toBe("{broken");
});
