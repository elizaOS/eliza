/**
 * Verifies that app-core's config barrel re-exports the shared
 * DEFAULT_APP_CONFIG intact (app name plus branding docs/app URLs).
 *
 * The branding URLs are asserted against `EXTERNAL_URLS`, the shared constant
 * `DEFAULT_APP_CONFIG` itself is built from, rather than against literal hosts.
 * This suite exists to prove the re-export is intact, so pinning literals here
 * only restated the brand table and went stale on the eliza.app consolidation
 * without any re-export actually breaking.
 */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { describe, expect, it } from "vitest";

import { DEFAULT_APP_CONFIG } from "./app-config";

describe("app-core app config exports", () => {
  it("re-exports the shared default app config", () => {
    expect(DEFAULT_APP_CONFIG.appName).toBe("Eliza");
    expect(DEFAULT_APP_CONFIG.branding?.docsUrl).toBe(EXTERNAL_URLS.docs);
    expect(DEFAULT_APP_CONFIG.branding?.appUrl).toBe(EXTERNAL_URLS.app);
  });
});
