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
    expect(source).not.toMatch(/active-server|apiBase|127\.0\.0\.1|localhost/);
  });
});
