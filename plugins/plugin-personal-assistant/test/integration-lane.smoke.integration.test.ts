/**
 * Repo integration-lane smoke — #11047.
 *
 * The repo-level integration lane (packages/test/vitest/integration.config.ts)
 * was dead in flat eliza checkouts for two independent reasons:
 *
 *   1. the `@elizaos/core` string alias prefix-matched subpath imports, so
 *      `@elizaos/core/node` rewrote to `<core entry file>/node` (ENOTDIR) and
 *      the personal-assistant plugin barrel could not load (plugin-calendly's
 *      dist imports `@elizaos/core/node`);
 *   2. every config path was `eliza/`-prefixed and cwd-relative, so the lane
 *      matched zero files unless the checkout was nested as literally `eliza/`
 *      inside a consumer workspace.
 *
 * This file being collected by the lane proves (2); the imports below
 * resolving proves (1). Keyless and DB-free by design so the CI leg runs it
 * unconditionally.
 *
 * Run:
 *   bunx vitest run --config packages/test/vitest/integration.config.ts \
 *     plugins/plugin-personal-assistant/test/integration-lane.smoke.integration.test.ts
 */
import { BaseMessageAdapter } from "@elizaos/core/node";
import { describe, expect, it } from "vitest";
import { personalAssistantPlugin } from "../src/plugin.js";

describe("repo integration lane boots in a flat checkout (#11047)", () => {
  it("resolves the @elizaos/core/node subpath through the lane's alias", () => {
    // Under the old prefix-matching alias this import failed at collection
    // time with ENOTDIR ("<core entry>/index.node.ts/node").
    expect(typeof BaseMessageAdapter).toBe("function");
  });

  it("loads the personal-assistant plugin barrel", () => {
    expect(personalAssistantPlugin.name).toBe(
      "@elizaos/plugin-personal-assistant",
    );
    expect(personalAssistantPlugin.actions?.length ?? 0).toBeGreaterThan(0);
    expect(personalAssistantPlugin.services?.length ?? 0).toBeGreaterThan(0);
  });
});
