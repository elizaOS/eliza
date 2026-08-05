/** Verifies platform-specific native plugin ownership before raw Capacitor sync. */

import { describe, expect, it } from "vitest";
import { resolveAndroidCapacitorPlugins } from "../capacitor.config";

describe("Android Capacitor plugin selection", () => {
  it("includes the Bun host and excludes the iOS-only llama bridge (#17465)", () => {
    const selected = resolveAndroidCapacitorPlugins({
      "@capacitor/core": "8.4.0",
      "@capacitor/app": "8.1.0",
      "@elizaos/capacitor-bun-runtime": "workspace:*",
      "@elizaos/capacitor-talkmode": "workspace:*",
      "llama-cpp-capacitor": "0.1.5",
      react: "19.0.0",
    });

    expect(selected).toEqual([
      "@capacitor/app",
      "@elizaos/capacitor-bun-runtime",
      "@elizaos/capacitor-talkmode",
    ]);
  });
});
