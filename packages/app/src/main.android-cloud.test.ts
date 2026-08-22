/** Dedicated Android Cloud renderer entry and policy boundary tests. */
import { describe, expect, it } from "vitest";
import source from "./main.android-cloud.tsx?raw";

const imports = source
  .split("\n")
  .filter((line) => /^(?:import|}\s+from)\b/.test(line.trim()))
  .join("\n");

describe("Android Cloud renderer entry", () => {
  it("mounts only the dedicated Play shell", () => {
    expect(source).toContain(
      'from "@elizaos/ui/android-cloud/AndroidCloudApp"',
    );
    expect(source).not.toMatch(/from ["']\.\/main["']/);
    expect(source).not.toMatch(/@elizaos\/ui\/App(?:["'/])/);
    expect(source).not.toMatch(/@elizaos\/ui\/state\/AppContext/);
    expect(source).not.toMatch(/service-worker|sw-registration/);
  });

  it("does not import cross-platform runtime composition", () => {
    expect(imports).not.toMatch(/local-agent|ios-|desktop|background-runner/i);
    expect(imports).not.toContain('from "@elizaos/ui"');
    expect(imports).not.toContain('from "@elizaos/ui/platform"');
    expect(imports).not.toContain('from "@elizaos/ui/bridge"');
    expect(imports).not.toContain('from "@elizaos/ui/events"');
  });

  it("keeps persistence and URL routing Cloud-scoped", () => {
    expect(source).toContain("CLOUD_PERSISTED_KEYS");
    expect(source).toContain("ANDROID_CLOUD_CONVERSATION_ID_KEY");
    expect(source).toContain("closeExternal={() => Browser.close()}");
    expect(source).toContain('parsed.protocol !== "elizaos:"');
    expect(source).not.toMatch(/active-server|127\.0\.0\.1|localhost/);
  });

  it("keeps the bearer in Android Keystore-backed storage", () => {
    const persistedKeys = source.slice(
      source.indexOf("const CLOUD_PERSISTED_KEYS"),
      source.indexOf("interface SecureCredentialsPlugin"),
    );
    expect(source).toContain('"ElizaSecureCredentials"');
    expect(source).toContain('"ElizaPlayVoice"');
    expect(source).toContain('"ElizaPlaySettings"');
    expect(source).not.toContain("@elizaos/capacitor-talkmode");
    expect(source).toContain("credentialStore: androidSecureCredentialStore");
    expect(persistedKeys).not.toContain("STEWARD_TOKEN_KEY");
    expect(source).toContain("Preferences.remove({ key: STEWARD_TOKEN_KEY })");
    expect(source).toContain("localStorage.removeItem(STEWARD_TOKEN_KEY)");
  });

  it("wires account deletion only to canonical Cloud HTTPS transport", () => {
    expect(source).toContain("androidCloudAccountLifecycle");
    expect(source).toContain("CapacitorHttp.request");
    expect(source).toContain(
      'data: { confirmation: "DELETE", consequencesAcknowledged: true }',
    );
    expect(source).toContain('data: { confirmation: "KEEP" }');
    expect(source).toContain("statusAccessEstablished !== true");
    expect(source).toContain("disableRedirects: true");
    expect(source).toContain("readonly status: number | null = null");
    expect(source).toContain("error.status === 401 || error.status === 404");
    expect(source).toContain("error.status !== 401");
    expect(source).toMatch(
      /url: `\$\{androidCloudClient\.apiBase\}\$\{path\}`/,
    );
    expect(source).not.toMatch(/http:\/\//);
  });
});
