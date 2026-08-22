/**
 * Guards retired transport cutovers across generated registries and the
 * runtime, configuration, LifeOps, and UI authorities that could reactivate them.
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

  it("does not advertise or activate the retired Signal transport", () => {
    expect(
      existsSync(
        path.join(repositoryRoot, "plugins/plugin-signal/src/index.ts"),
      ),
    ).toBe(true);
    expect(channelPluginMap).not.toHaveProperty("signal");
    expect(shortIdPluginMap).not.toHaveProperty("signal");
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
      "packages/agent/scripts/build-mobile-bundle.mjs",
      ".github/workflows/build-agent-image.yml",
      ".github/workflows/codeql.yml",
      "packages/app-core/packaging/snap/snapcraft.yaml",
      "packages/app-core/scripts/docker-ci-smoke.sh",
      "packages/app-core/scripts/generate-plugin-index.js",
      "packages/app-core/vitest.config.ts",
      "packages/scripts/vitest/default.config.ts",
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
      "scripts/training-harvest/manifest.json",
      "tsconfig.json",
      "turbo.json",
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

    const statusTombstone = readFileSync(
      path.join(
        repositoryRoot,
        "packages/agent/src/api/absent-plugin-route-stubs.ts",
      ),
      "utf8",
    );
    expect(statusTombstone).toMatch(
      /capabilityId:\s*["']signal-unsupported["'][\s\S]+?statusCode:\s*501[\s\S]+?status:\s*["']unsupported["'][\s\S]+?SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE/,
    );

    const inactiveAuthorities: Array<[string, RegExp]> = [
      [
        "packages/agent/src/api/plugin-discovery-helpers.ts",
        /applySignalQrOverride|signalAuthExists|signal-auth|signal:\s*["']#signal["']|["']signal["'],?\s*\/\/.*connector/i,
      ],
      [
        "packages/agent/src/api/server.ts",
        /getOptionalPluginApi[^;]+["']signal["']|applySignalQrOverride|signalPairingSessions/i,
      ],
      [
        "packages/agent/src/actions/plugin.ts",
        /signal:\s*["']\/api\/signal\/disconnect["']/i,
      ],
      [
        "packages/agent/src/runtime/build-character-config.ts",
        /SIGNAL_ACCOUNT_NUMBER/,
      ],
      [
        "packages/agent/src/config/zod-schema.core.ts",
        /signal:\s*QueueModeSchema/,
      ],
      [
        "packages/agent/src/config/zod-schema.hooks.ts",
        /z\.literal\(["']signal["']\)/,
      ],
      [
        "packages/agent/scripts/mobile-stubs/null-plugin.cjs",
        /applySignalQrOverride|handleSignalRoute/,
      ],
      [
        "packages/agent/scripts/build-mobile-bundle.mjs",
        /applySignalQrOverride/,
      ],
      ["packages/shared/src/config/schema.ts", /["']signal["']/],
      [
        "packages/shared/src/config/zod-schema.core.ts",
        /signal:\s*QueueModeSchema/,
      ],
      ["packages/shared/src/config/types.hooks.ts", /["']signal["']/],
      [
        "packages/shared/src/connector-account-catalog.ts",
        /connectorId:\s*["']signal["']|provider:\s*["']signal["']/,
      ],
      [
        "packages/ui/src/components/connectors/connector-ui-groups.ts",
        /signal:\s*["']messaging["']/,
      ],
      [
        "packages/shared/src/contracts/personal-assistant.ts",
        /StartLifeOpsSignalPairing|LifeOpsSignalPairingStatus|LifeOpsSignal|["']signal["']/,
      ],
      [
        "plugins/plugin-health/src/contracts/lifeops.ts",
        /StartLifeOpsSignalPairing|LifeOpsSignalPairingStatus|LifeOpsSignal|["']signal["']/,
      ],
      [
        "plugins/plugin-registry/src/api/plugin-routes.ts",
        /applySignalQrOverride/,
      ],
      [
        "plugins/plugin-personal-assistant/src/lifeops/connectors/default-pack.ts",
        /createSignalConnectorContribution|["']\.\/signal\.js["']/,
      ],
      [
        "plugins/plugin-personal-assistant/src/lifeops/channels/default-pack.ts",
        /kind:\s*["']signal["']|connectorKind:\s*["']signal["']/,
      ],
      [
        "plugins/plugin-personal-assistant/src/automation-node-contributor.ts",
        /lifeops:signal|resolveSignalStatus|Pair the owner Signal account/,
      ],
      [
        "plugins/plugin-personal-assistant/src/lifeops/escalation-ladders.ts",
        /channelKey:\s*["']signal["']/,
      ],
      [
        "plugins/plugin-personal-assistant/src/default-packs/escalation-ladders.ts",
        /channelKey:\s*["']signal["']/,
      ],
      [
        "packages/ui/src/api/client-skills.ts",
        /(?:get|start|stop|disconnect)Signal|\/api\/signal\//,
      ],
      ["packages/ui/src/browser.ts", /useSignalPairing/],
      ["packages/ui/src/hooks/index.ts", /useSignalPairing/],
      [
        "packages/ui/src/components/connectors/connector-mode-registry.ts",
        /registerConnectorModes\(["']signal["']/,
      ],
      [
        "plugins/plugin-inbox/src/actions/inbox.ts",
        /["']signal["']|\bSignal\b/,
      ],
      ["plugins/plugin-inbox/src/types.ts", /["']signal["']|\bSignal\b/],
      [
        "plugins/plugin-personal-assistant/src/actions/connector.ts",
        /["']signal["']|\bSignal\b|\/api\/signal\//,
      ],
      [
        "plugins/plugin-personal-assistant/src/lifeops/cross-channel-search.ts",
        /["']signal["']|\bSignal\b/,
      ],
      [
        "plugins/plugin-personal-assistant/src/lifeops/service.ts",
        /LifeOpsSignal|signalService|["']signal["']/,
      ],
      [
        "plugins/plugin-scheduling/src/scheduled-task/escalation.ts",
        /["']signal["']|\bSignal\b/,
      ],
      [
        "packages/ui/src/cloud/connectors/CloudConnectorsUpsell.tsx",
        /\bSignal\b/,
      ],
      [
        "packages/scenario-runner/test/mocks/scripts/lifeops-readonly-connector-snapshot.ts",
        /lifeops\/connectors\/signal|signal\.status/i,
      ],
    ];
    for (const [authority, forbidden] of inactiveAuthorities) {
      expect(
        readFileSync(path.join(repositoryRoot, authority), "utf8"),
      ).not.toMatch(forbidden);
    }

    for (const removedSurface of [
      "plugins/plugin-signal/src/local-client.ts",
      "plugins/plugin-signal/src/pairing-service.ts",
      "plugins/plugin-signal/src/rpc.ts",
      "plugins/plugin-signal/src/service.ts",
      "packages/scenario-runner/test/mocks/environments/signal.json",
      "packages/scenario-runner/test/mocks/mockoon/signal.json",
      "packages/ui/src/components/connectors/SignalQrOverlay.tsx",
      "packages/ui/src/hooks/useSignalPairing.ts",
      "plugins/plugin-personal-assistant/src/lifeops/connectors/signal.ts",
      "plugins/plugin-personal-assistant/src/lifeops/signal-runtime-config.ts",
      "plugins/plugin-personal-assistant/src/lifeops/domains/signal-service.ts",
      "plugins/plugin-personal-assistant/src/lifeops/service-mixin-signal.ts",
      "plugins/plugin-personal-assistant/test/lifeops-signal.real.e2e.test.ts",
      "plugins/plugin-personal-assistant/test/scenarios/corpus/lifeops.cross-channel/cross-channel.signal-permission-denied-degraded.scenario.ts",
    ]) {
      expect(existsSync(path.join(repositoryRoot, removedSurface))).toBe(false);
    }
  });
});
