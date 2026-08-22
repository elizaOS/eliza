/**
 * Guards the hard cutover from the retired BlueBubbles bridge to the native
 * iMessage plugin across the generated first-party registration authorities.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import channelPluginMap from "./channel-plugin-map.json" with { type: "json" };
import generatedRegistry from "./generated.json" with { type: "json" };
import shortIdPluginMap from "./short-id-plugin-map.json" with { type: "json" };

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const retiredConnector = "bluebubbles";
const retiredPackage = `@elizaos/plugin-${retiredConnector}`;

describe("retired transport registration", () => {
  it("does not ship or register the retired BlueBubbles bridge", () => {
    expect(
      existsSync(
        path.join(
          repositoryRoot,
          "plugins",
          `plugin-${retiredConnector}`,
          "package.json",
        ),
      ),
    ).toBe(false);
    expect(channelPluginMap).not.toHaveProperty(retiredConnector);
    expect(shortIdPluginMap).not.toHaveProperty(retiredConnector);
    expect(
      generatedRegistry.entries.some(
        (plugin) => plugin.npmName === retiredPackage,
      ),
    ).toBe(false);
  });

  it("keeps native iMessage as the first-party connector", () => {
    expect(channelPluginMap.imessage).toBe("@elizaos/plugin-imessage");
    expect(
      generatedRegistry.entries.some(
        (plugin) => plugin.npmName === "@elizaos/plugin-imessage",
      ),
    ).toBe(true);
  });
});
