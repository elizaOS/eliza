/**
 * Guards the hard cutover from the retired BlueBubbles bridge to the native
 * iMessage plugin across the generated first-party registration authorities.
 */
import { execFileSync } from "node:child_process";
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
const retainedReferenceFiles = new Set([
  "packages/cloud/api/webhooks/blooio/[orgId]/route.test.ts",
  "packages/registry/src/first-party/retired-transport-registration.test.ts",
  "packages/scripts/type-duplication-triage.md",
  "packages/ui/src/components/connectors/IMessageStatusPanel.test.tsx",
  "plugins/plugin-imessage/AGENTS.md",
  "plugins/plugin-imessage/CLAUDE.md",
  "plugins/plugin-imessage/README.md",
  "plugins/plugin-inbox/src/inbox/message-fetcher.ts",
]);

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
      "packages/app-core/scripts/run-mobile-build.mjs",
      "packages/app-core/scripts/mobile/targets/android.mjs",
      "packages/cloud/api/src/_router.generated.ts",
      "packages/cloud/sdk/src/public-routes.ts",
      "packages/cloud/shared/src/lib/services/agent-gateway-router.ts",
      "packages/cloud/shared/src/lib/services/phone-gateway-devices.ts",
      "packages/core/src/security/incoming-message-security.ts",
      "packages/scripts/release-cohort.json",
      "packages/shared/src/config/schema.ts",
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
      "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaSmsGatewayService.java",
      "packages/app-core/scripts/check-sms-gateway-readiness.mjs",
      "packages/app-core/scripts/install-android-sms-gateway.mjs",
      "packages/app-core/scripts/verify-cloud-sms-onboarding-flow.mjs",
      "packages/scenario-runner/test/mocks/mockoon/bluebubbles.json",
      "packages/skills/skills/bluebubbles/SKILL.md",
      "packages/test/scenarios/gateway/bluebubbles.imessage.receive.scenario.ts",
      "packages/test/scenarios/gateway/bluebubbles.imessage.send-blue.scenario.ts",
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

  it("rejects the retired transport across every tracked repository surface", () => {
    const unexpectedReferences = execFileSync(
      "git",
      ["grep", "-Il", "-i", retiredConnector, "--"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .trim()
      .split("\n")
      .filter((relativePath) => !retainedReferenceFiles.has(relativePath));

    expect(unexpectedReferences).toEqual([]);
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
