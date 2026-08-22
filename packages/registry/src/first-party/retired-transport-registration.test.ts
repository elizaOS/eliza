/**
 * Guards the hard cutover from the retired BlueBubbles bridge to the native
 * iMessage plugin across the generated first-party registration authorities.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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

function maintainedFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...maintainedFiles(resolved));
    else files.push(resolved);
  }
  return files;
}

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

  it("registers the local WhatsApp connector only as in-process Baileys", () => {
    expect(channelPluginMap.whatsapp).toBe("@elizaos/plugin-whatsapp");
    const whatsappEntry = generatedRegistry.entries.find(
      (plugin) => plugin.npmName === "@elizaos/plugin-whatsapp",
    );
    expect(whatsappEntry).toBeDefined();
    expect(whatsappEntry).not.toHaveProperty("auth");
    expect(whatsappEntry?.accounts?.agent?.authKind).toBe("qr");

    const manifest = readFileSync(
      path.join(repositoryRoot, "plugins/plugin-whatsapp/package.json"),
      "utf8",
    );
    expect(manifest).toContain('"@whiskeysockets/baileys"');
    expect(manifest).not.toMatch(
      /whatsapp-cloud-webhook|WHATSAPP_ACCESS_TOKEN|WHATSAPP_PHONE_NUMBER_ID|WHATSAPP_APP_SECRET/i,
    );

    const localAuthorityFiles = [
      "packages/registry/src/first-party/generated.json",
      "packages/scripts/post-merge-secrets.txt",
      ".env.test.example",
      ...[
        "packages/agent/src",
        "packages/core/src",
        "packages/app-core/src",
        "packages/app-core/test/live-agent",
        "packages/shared/src/contracts",
        "plugins/plugin-health/src/contracts",
        "plugins/plugin-personal-assistant/src/lifeops",
        "plugins/plugin-personal-assistant/test/support",
        "packages/scripts/test-console",
        "packages/ui/src/components/connectors",
        "scripts/lifeops",
        "docs/testing",
        "packages/docs/tracks/agent",
      ].flatMap((authorityRoot) =>
        maintainedFiles(path.join(repositoryRoot, authorityRoot)),
      ),
    ].map((authority) =>
      path.isAbsolute(authority)
        ? authority
        : path.join(repositoryRoot, authority),
    );
    const retiredLocalAuthority =
      /whatsapp-cloud-webhook|whatsappSessionPath|WHATSAPP_(?:TOKEN|ACCESS_TOKEN|PHONE_NUMBER_ID|WEBHOOK_VERIFY_TOKEN|APP_SECRET|BUSINESS_ACCOUNT_ID|SESSION_PATH)|whatsapp_business_account|graph\.facebook\.com[^\n]{0,200}whatsapp|whatsapp[^\n]{0,120}(?:cloud api|webhook|access token|phone number id|app secret)|(?:cloud api|webhook|access token|phone number id|app secret)[^\n]{0,120}whatsapp/i;
    const retiredCoreAuthority =
      /WHATSAPP_(?:TOKEN|ACCESS_TOKEN|PHONE_NUMBER_ID|WEBHOOK_VERIFY_TOKEN|APP_SECRET|BUSINESS_ACCOUNT_ID|SESSION_PATH)|whatsapp-cloud-webhook|whatsapp_business_account|graph\.facebook\.com[^\n]{0,200}whatsapp/i;
    for (const authority of new Set(localAuthorityFiles)) {
      let source = readFileSync(authority, "utf8");
      if (
        authority ===
        path.join(
          repositoryRoot,
          "packages/shared/src/contracts/first-run-routes.ts",
        )
      ) {
        expect(source.match(/whatsappSessionPath/g), authority).toHaveLength(1);
        source = source.replace(
          "whatsappSessionPath",
          "retired-field-tombstone",
        );
      }
      expect(source, authority).not.toMatch(
        authority.startsWith(path.join(repositoryRoot, "packages/core/"))
          ? retiredCoreAuthority
          : retiredLocalAuthority,
      );
    }

    for (const pluginFile of maintainedFiles(
      path.join(repositoryRoot, "plugins/plugin-whatsapp"),
    )) {
      expect(readFileSync(pluginFile, "utf8"), pluginFile).not.toMatch(
        /whatsapp-cloud-webhook|WHATSAPP_(?:ACCESS_TOKEN|PHONE_NUMBER_ID|WEBHOOK_VERIFY_TOKEN|APP_SECRET|BUSINESS_ACCOUNT_ID)|graph\.facebook\.com|cloudapi|whatsapp_business_account|handleWebhook|verifyWebhook/i,
      );
    }

    const directRuntime = readFileSync(
      path.join(
        repositoryRoot,
        "plugins/plugin-whatsapp/src/runtime-service.ts",
      ),
      "utf8",
    );
    expect(directRuntime).toContain("new BaileysClient");
    expect(directRuntime).not.toMatch(
      /node:child_process|\bspawn\s*\(|\bexec\s*\(|cloudapi|handleWebhook|verifyWebhook/i,
    );

    for (const removedSurface of [
      "plugins/plugin-whatsapp/src/client.ts",
      "plugins/plugin-whatsapp/src/webhook-auth.ts",
      "plugins/plugin-whatsapp/src/clients/factory.ts",
      "plugins/plugin-whatsapp/src/api/whatsapp-routes.ts",
    ]) {
      expect(existsSync(path.join(repositoryRoot, removedSurface))).toBe(false);
    }
  });

  it("discovers extensionless and uncommon-extension authority files", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "retired-transport-ratchet-"),
    );
    try {
      writeFileSync(
        path.join(root, "Dockerfile"),
        "WHATSAPP_ACCESS_TOKEN=retired\n",
      );
      writeFileSync(
        path.join(root, "connector.env.production"),
        "WHATSAPP_TOKEN=retired\n",
      );
      expect(
        maintainedFiles(root)
          .map((file) => path.basename(file))
          .sort(),
      ).toEqual(["Dockerfile", "connector.env.production"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
