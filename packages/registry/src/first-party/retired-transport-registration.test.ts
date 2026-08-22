/**
 * Guards the hard cutover from the retired BlueBubbles bridge to the native
 * iMessage plugin across the generated first-party registration authorities.
 */
import { existsSync, readFileSync } from "node:fs";
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

    for (const authority of [
      "packages/agent/src/runtime/core-plugins.ts",
      "packages/agent/src/config/env-vars.ts",
      "packages/agent/src/config/zod-schema.ts",
      "packages/app-core/package.json",
      "packages/app-core/src/services/connector-secret-inventory.ts",
      "packages/cloud/api/src/_router.generated.ts",
      "packages/scripts/release-cohort.json",
      "packages/ui/src/components/connectors/connector-mode-registry.ts",
      "packages/ui/src/components/connectors/connector-setup-panel-registry.ts",
    ]) {
      expect(
        readFileSync(path.join(repositoryRoot, authority), "utf8"),
      ).not.toMatch(/bluebubbles/i);
    }

    for (const removedSurface of [
      "packages/cloud/api/v1/phone-gateways/bluebubbles/route.ts",
      "packages/cloud/api/webhooks/bluebubbles/route.ts",
      "packages/cloud/scripts/install-bluebubbles-relay.mjs",
      "packages/scenario-runner/test/mocks/mockoon/bluebubbles.json",
      "packages/ui/src/components/connectors/BlueBubblesStatusPanel.tsx",
    ]) {
      expect(existsSync(path.join(repositoryRoot, removedSurface))).toBe(false);
    }
  });

  it("keeps native iMessage as the first-party connector", () => {
    expect(channelPluginMap.imessage).toBe("@elizaos/plugin-imessage");
    expect(
      generatedRegistry.entries.some(
        (plugin) => plugin.npmName === "@elizaos/plugin-imessage",
      ),
    ).toBe(true);
  });

  it("does not advertise or activate an external-process Signal bridge", () => {
    expect(channelPluginMap).not.toHaveProperty("signal");
    expect(
      generatedRegistry.entries.some(
        (plugin) => plugin.npmName === "@elizaos/plugin-signal",
      ),
    ).toBe(false);

    for (const authority of [
      "packages/agent/src/runtime/core-plugins.ts",
      "packages/agent/src/config/env-vars.ts",
      "packages/agent/src/config/zod-schema.ts",
      "packages/agent/src/config/zod-schema.providers-core.ts",
      "packages/agent/src/api/server.ts",
      ".github/workflows/build-agent-image.yml",
      "packages/app-core/packaging/snap/snapcraft.yaml",
      "packages/registry/src/first-party/channel-plugin-map.json",
      "packages/registry/src/first-party/generated.json",
      "packages/scenario-runner/test/mocks/helpers/provider-coverage.ts",
      "packages/scenario-runner/test/mocks/scripts/start-mocks.ts",
      "packages/scripts/release-cohort.json",
      "packages/training/scripts/synthesize_messaging_actions.py",
      "packages/ui/src/components/connectors/connector-account-options.ts",
      "packages/ui/src/components/connectors/connector-setup-panel-registry.ts",
      "scripts/lifeops/connector-paths.mjs",
      "scripts/lifeops/credential-probes.mjs",
      "scripts/lifeops/hitl-credential-dashboard.mjs",
    ]) {
      expect(
        readFileSync(path.join(repositoryRoot, authority), "utf8"),
      ).not.toMatch(
        /@elizaos\/plugin-signal|SIGNAL_HTTP_URL|SIGNAL_CLI_PATH|signal-cli|signald/i,
      );
    }

    const tombstoneSource = readFileSync(
      path.join(repositoryRoot, "plugins/plugin-signal/src/index.ts"),
      "utf8",
    );
    expect(tombstoneSource).toContain("SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE");
    expect(tombstoneSource).not.toMatch(
      /node:child_process|\bspawn\s*\(|\bfetch\s*\(/,
    );

    for (const removedSurface of [
      "plugins/plugin-signal/src/local-client.ts",
      "plugins/plugin-signal/src/pairing-service.ts",
      "plugins/plugin-signal/src/rpc.ts",
      "plugins/plugin-signal/src/service.ts",
      "packages/scenario-runner/test/mocks/environments/signal.json",
      "packages/scenario-runner/test/mocks/mockoon/signal.json",
      "packages/ui/src/components/connectors/SignalQrOverlay.tsx",
    ]) {
      expect(existsSync(path.join(repositoryRoot, removedSurface))).toBe(false);
    }
  });
});
