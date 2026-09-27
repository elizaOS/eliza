/** Proves the production Notes surface admits every declared Notes capability through the real view broker. */

import { resolveSurfaceManifest } from "@elizaos/core/views/surface-manifest";
import {
  brokerViewInteract,
  viewManifestAllowsCapability,
} from "@elizaos/ui/components/views/view-capability-broker";
import { expect, it } from "vitest";
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { NOTES_SURFACE } from "./surface.js";

it("grants every declared Notes capability to mounted-view interactions (#31534)", async () => {
  const manifest = resolveSurfaceManifest({ surface: NOTES_SURFACE });
  expect(NOTES_CAPABILITIES.length).toBeGreaterThan(0);
  for (const capability of NOTES_CAPABILITIES) {
    expect(
      viewManifestAllowsCapability(manifest, capability.id, NOTES_CAPABILITIES),
    ).toBe(true);
  }
  const gated = brokerViewInteract(
    "notes",
    manifest,
    async (capability) => ({ capability }),
    NOTES_CAPABILITIES,
  );
  await expect(gated("create-note", { content: "Buy milk" })).resolves.toEqual({
    capability: "create-note",
  });
});
