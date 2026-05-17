import { describe, expect, it } from "vitest";
import { normalizeCloudSiteUrl, resolveCloudApiBaseUrl } from "./base-url";

describe("Eliza Cloud base URL normalization", () => {
  it("normalizes the API host back to the browser site host", () => {
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai",
    );
    expect(normalizeCloudSiteUrl("https://api.elizacloud.ai/api/v1")).toBe(
      "https://www.elizacloud.ai",
    );
  });

  it("resolves canonical API paths from API host input", () => {
    expect(resolveCloudApiBaseUrl("https://api.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai/api/v1",
    );
  });
});
