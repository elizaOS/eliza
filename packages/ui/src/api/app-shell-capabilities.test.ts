/**
 * Unit coverage for the API-base capability predicates (limited cloud vs full
 * app-shell routes). Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  isLimitedCloudAgentApiBase,
  isLimitedCloudAgentApiResourceUrl,
  supportsFullAppShellRoutes,
} from "./app-shell-capabilities";

describe("app shell capabilities", () => {
  it("treats direct shared cloud agent bases as limited chat adapters", () => {
    const base =
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123/bridge";

    expect(isLimitedCloudAgentApiBase(base)).toBe(true);
    expect(supportsFullAppShellRoutes(base)).toBe(false);
  });

  it("treats dedicated cloud agent subdomains as limited chat adapters", () => {
    const base = "https://37911a1e-ed40-4626-88f5.elizacloud.ai";

    expect(isLimitedCloudAgentApiBase(base)).toBe(true);
    expect(supportsFullAppShellRoutes(base)).toBe(false);
  });

  it("keeps local and control-plane bases eligible for full shell routes", () => {
    expect(supportsFullAppShellRoutes("http://127.0.0.1:3000")).toBe(true);
    expect(supportsFullAppShellRoutes("https://elizacloud.ai")).toBe(true);
    expect(supportsFullAppShellRoutes("")).toBe(true);
  });

  it("detects absolute API resources served by limited cloud agents", () => {
    expect(
      isLimitedCloudAgentApiResourceUrl(
        "https://37911a1e-ed40-4626-88f5.elizacloud.ai/api/views/notes/hero",
      ),
    ).toBe(true);
    expect(
      isLimitedCloudAgentApiResourceUrl(
        "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123/api/apps/hero/steward",
      ),
    ).toBe(true);
    expect(
      isLimitedCloudAgentApiResourceUrl(
        "https://37911a1e-ed40-4626-88f5.elizacloud.ai/app-heroes/steward.png",
      ),
    ).toBe(false);
  });
});
