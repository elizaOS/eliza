/**
 * Verifies that app-core's config barrel re-exports the shared
 * DEFAULT_APP_CONFIG intact (app name plus branding docs/app URLs).
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_APP_CONFIG } from "./app-config";

describe("app-core app config exports", () => {
  it("re-exports the shared default app config", () => {
    expect(DEFAULT_APP_CONFIG.appName).toBe("Eliza");
    expect(DEFAULT_APP_CONFIG.branding?.docsUrl).toBe(
      "https://docs.elizaos.ai",
    );
    expect(DEFAULT_APP_CONFIG.branding?.appUrl).toBe(
      "https://app.elizacloud.ai",
    );
  });
});
