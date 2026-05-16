import { describe, expect, it } from "vitest";

import { DEFAULT_APP_CONFIG } from "./app-config";

describe("app-core app config exports", () => {
  it("re-exports the shared default app config", () => {
    expect(DEFAULT_APP_CONFIG.appName).toBe("Eliza");
    expect(DEFAULT_APP_CONFIG.branding?.docsUrl).toBe("https://eliza.how");
  });
});
