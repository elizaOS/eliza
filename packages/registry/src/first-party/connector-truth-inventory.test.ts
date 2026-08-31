/**
 * Registry truth ratchets (#24373): the first-party registry may only claim
 * channels backed by bundled first-party code, external transport entries must
 * stay unregistered, and the generated connector truth inventory must reflect
 * the plugins' actual registration literals. Filesystem-backed and
 * deterministic; complements retired-transport-registration.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import channelPluginMap from "./channel-plugin-map.json" with { type: "json" };
import truthInventory from "./connector-truth-inventory.json" with {
  type: "json",
};
import { generateFirstPartyRegistry, pathRelativeToRepoRoot } from "./generate";
import generatedRegistry from "./generated.json" with { type: "json" };
import { connectorEntrySchema, pluginEntrySchema } from "./schema";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

/** External transports unregistered by #24373 — none may return. */
const EXTERNAL_TRANSPORT_IDS = [
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "tlon",
  "zalo",
  "zalouser",
  "twilio",
] as const;

/**
 * Legacy channel aliases kept for config compatibility with older characters.
 * Every alias must map to a channel that the same plugin really registers;
 * the "derives every row" test enforces the mapping per row.
 */
const LEGACY_CHANNEL_ALIASES = new Map([
  ["discordLocal", "discord"],
  ["twitter", "x"],
  ["googlechat", "google-chat"],
  // Blooio is an integrated transport of plugin-imessage (develop 9b93ec4374
  // made the connector canonical); its channel key resolves to the imessage
  // registration source rather than a standalone registration.
  ["blooio", "imessage"],
]);

describe("external transport unregistration (#24373)", () => {
  it("removes every external transport entry from the first-party registry", () => {
    const ids = new Set(generatedRegistry.entries.map((e) => e.id));
    for (const id of EXTERNAL_TRANSPORT_IDS) {
      expect(ids, `entry "${id}" must stay unregistered`).not.toContain(id);
    }
  });

  it("keeps the external transport curated files deleted", () => {
    const removedSurfaces = [
      ...EXTERNAL_TRANSPORT_IDS.map(
        (id) =>
          `packages/registry/src/first-party/curated/connectors/${id}.json`,
      ),
      "packages/registry/src/first-party/curated/plugins/blooio.json",
      "packages/registry/src/first-party/curated/plugins/twilio.json",
    ];
    for (const surface of removedSurfaces) {
      expect(
        existsSync(path.join(repositoryRoot, surface)),
        `${surface} must not return`,
      ).toBe(false);
    }
  });

  it("drops external channel claims from the generated channel map", () => {
    for (const id of EXTERNAL_TRANSPORT_IDS) {
      expect(
        channelPluginMap,
        `channel "${id}" must not resolve to an external package`,
      ).not.toHaveProperty(id);
    }
  });

  it("forbids external transport claims across registration authorities", () => {
    const authorities = [
      "packages/agent/src/api/plugin-discovery-helpers.ts",
      "packages/agent/src/api/connector-health.ts",
      "packages/agent/src/config/env-vars.ts",
      "packages/agent/src/config/zod-schema.core.ts",
      "packages/agent/src/config/zod-schema.providers-core.ts",
      "packages/agent/src/config/zod-schema.ts",
      "packages/agent/src/config/schema.ts",
      "packages/agent/src/runtime/build-character-config.ts",
      "packages/shared/src/config/schema.ts",
      "packages/shared/src/config/zod-schema.core.ts",
      "packages/app-core/src/services/connector-secret-inventory.ts",
      "packages/ui/src/components/connectors/connector-ui-groups.ts",
      "packages/ui/src/components/connectors/connector-mode-registry.ts",
      "packages/docs/tracks/agent/connect-channels.mdx",
    ];
    for (const authority of authorities) {
      const text = readFileSync(path.join(repositoryRoot, authority), "utf8");
      for (const id of EXTERNAL_TRANSPORT_IDS) {
        expect(text, `${authority} still claims "${id}"`).not.toMatch(
          new RegExp(`"${id}"|plugin-${id}`, "i"),
        );
      }
    }
  });

  it("leaves the first-party cloud product surfaces intact", () => {
    // The Eliza Cloud SMS/iMessage gateway routes (packages/cloud/api) and the
    // cloud connector cards are a real product backend, not registry claims.
    for (const cloudSurface of [
      "packages/cloud/api/v1/blooio/connect/route.ts",
      "packages/cloud/api/eliza-app/webhook/twilio/route.ts",
      "packages/ui/src/cloud/connectors/blooio-connection.tsx",
      "packages/ui/src/cloud/connectors/twilio-connection.tsx",
    ]) {
      expect(
        existsSync(path.join(repositoryRoot, cloudSurface)),
        `${cloudSurface} is product code and must remain`,
      ).toBe(true);
    }
  });
});

describe("bundled channel-claim truth (#24373)", () => {
  it("maps every channel key to a bundled plugin that exists in-tree", () => {
    for (const [channel, packageNameValue] of Object.entries(
      channelPluginMap,
    )) {
      const packageName = packageNameValue as string;
      expect(
        packageName,
        `channel "${channel}" must resolve into the @elizaos scope`,
      ).toMatch(/^@elizaos\//);
      const pluginDir = path.join(
        repositoryRoot,
        "plugins",
        packageName.replace("@elizaos/", ""),
      );
      expect(
        existsSync(pluginDir),
        `channel "${channel}" claims ${packageName} but the plugin directory is absent`,
      ).toBe(true);
      const entry = generatedRegistry.entries.find(
        (e) => e.npmName === packageName,
      );
      expect(
        entry,
        `channel "${channel}" claims ${packageName} without a registry entry`,
      ).toBeDefined();
      expect(entry?.source).toBe("bundled");
    }
  });

  it("rejects store entries that claim channels at the schema level", () => {
    const baseConnector = {
      id: "external-connector",
      name: "External Connector",
      kind: "connector",
      subtype: "messaging",
      source: "store",
      tags: [],
      config: {},
      render: {
        visible: false,
        pinTo: [],
        style: "card",
        group: "other",
        actions: [],
      },
      resources: {},
      dependsOn: [],
      channels: ["external-connector"],
    };
    expect(connectorEntrySchema.safeParse(baseConnector).success).toBe(false);

    const basePlugin = {
      id: "external-plugin",
      name: "External Plugin",
      kind: "plugin",
      subtype: "other",
      source: "store",
      tags: [],
      config: {},
      render: {
        visible: false,
        pinTo: [],
        style: "card",
        group: "other",
        actions: [],
      },
      resources: {},
      dependsOn: [],
      channels: ["external-plugin"],
    };
    expect(pluginEntrySchema.safeParse(basePlugin).success).toBe(false);

    // The same entry without channel claims stays valid — store listings for
    // genuinely external plugins remain allowed, they just cannot claim a
    // channel registration.
    expect(
      connectorEntrySchema.safeParse({ ...baseConnector, channels: [] })
        .success,
    ).toBe(true);
    expect(
      pluginEntrySchema.safeParse({ ...basePlugin, channels: [] }).success,
    ).toBe(true);
  });
});

describe("connector truth inventory (#24373)", () => {
  type InventoryRow = (typeof truthInventory.connectors)[number];

  it("commits exactly the artifacts the generator emits (drift gate)", () => {
    // In-process equivalent of `generate:first-party:check` — the committed
    // generated.json, channel map, and truth inventory must equal a fresh
    // regeneration, so the ratchets above can never silently diverge from
    // the registration sources the generator scans.
    const next = generateFirstPartyRegistry();
    const expectedGenerated = JSON.parse(next.full);
    expect(generatedRegistry).toEqual(expectedGenerated);
    const expectedChannels = JSON.parse(next.channels);
    expect(channelPluginMap).toEqual(expectedChannels);
    const expectedInventory = JSON.parse(next.inventory);
    expect(truthInventory).toEqual(expectedInventory);
  });

  it("covers exactly the bundled channel-claiming entries", () => {
    const claiming = generatedRegistry.entries.filter(
      (e) => (e.channels?.length ?? 0) > 0,
    );
    expect(new Set(claiming.map((e) => e.npmName))).toEqual(
      new Set(
        truthInventory.connectors.map((r: InventoryRow) => r.packageName),
      ),
    );
  });

  it("emits repository-relative POSIX site paths on every platform", () => {
    // `pathRelativeToRepoRoot` must use `path.relative` + separator
    // normalization: a literal `${REPO_ROOT}/` replace never matches Windows
    // `\`-joined paths, so writer mode would commit machine-specific
    // `C:\Users\...` paths and check mode would fail on a pristine Windows
    // checkout. The invariant runs against BOTH the committed artifact and
    // the freshly generated inventory — asserting only the committed JSON
    // would not regression-test the generator on POSIX lanes.
    const assertRepoRelativeSites = (inventory: {
      connectors: InventoryRow[];
    }) => {
      for (const row of inventory.connectors) {
        expect(row.registrationSites.length).toBeGreaterThan(0);
        for (const site of row.registrationSites) {
          expect(
            path.isAbsolute(site),
            `${row.plugin}: registration site "${site}" must be repository-relative, not absolute`,
          ).toBe(false);
          expect(
            site,
            `${row.plugin}: registration site "${site}" must not contain a Windows separator`,
          ).not.toContain("\\");
          expect(
            /^[A-Za-z]:/.test(site),
            `${row.plugin}: registration site "${site}" must not carry a drive prefix`,
          ).toBe(false);
          expect(
            site.startsWith("../") || site === "..",
            `${row.plugin}: registration site "${site}" must stay inside the repository root`,
          ).toBe(false);
        }
      }
    };
    assertRepoRelativeSites(truthInventory);
    assertRepoRelativeSites(JSON.parse(generateFirstPartyRegistry().inventory));
  });

  it("normalizes site paths under Windows path semantics", () => {
    // Pins the exact defect mashingaan reported: a literal
    // `${REPO_ROOT}/` prefix replace silently leaves Windows-joined absolute
    // paths untouched. Injecting `path.win32` proves the shipped helper
    // normalizes them deterministically on every host lane.
    const winRoot = "C:\\repo\\eliza";
    const winFile = "C:\\repo\\eliza\\plugins\\plugin-discord\\src\\service.ts";
    expect(pathRelativeToRepoRoot(winFile, path.win32, winRoot)).toBe(
      "plugins/plugin-discord/src/service.ts",
    );
    // Host (POSIX) semantics emit the same repository-relative spelling.
    const posixFile = "/repo/eliza/plugins/plugin-discord/src/service.ts";
    expect(pathRelativeToRepoRoot(posixFile, path.posix, "/repo/eliza")).toBe(
      "plugins/plugin-discord/src/service.ts",
    );
  });

  it("derives every row from a real production registration site", () => {
    for (const row of truthInventory.connectors as InventoryRow[]) {
      expect(row.registrationSites.length).toBeGreaterThan(0);
      for (const site of row.registrationSites) {
        expect(
          existsSync(path.join(repositoryRoot, site)),
          `${row.plugin}: registration site ${site} does not exist`,
        ).toBe(true);
        const source = readFileSync(path.join(repositoryRoot, site), "utf8");
        expect(
          source,
          `${row.plugin}: site ${site} no longer constructs a registration`,
        ).toMatch(/registerMessageConnector|MessageConnectorRegistration/);
      }
      // At least one registration source must equal the entry's primary id
      // (the first channel is the connector's own name; remaining channels are
      // aliases such as discordLocal/twitter resolving to the same plugin).
      const sources = new Set(
        (row.registrations as Array<{ source: string }>).map((r) => r.source),
      );
      const primaryChannel = row.channels.find(
        (c) => c === row.plugin.replace("plugin-", ""),
      );
      if (primaryChannel) {
        expect(
          sources,
          `${row.plugin}: claimed channel "${primaryChannel}" has no matching registration source`,
        ).toContain(primaryChannel);
      }
      expect(row.registrations.length).toBeGreaterThan(0);

      // Every claimed channel must be either a registration source or an
      // explicitly reviewed legacy alias — a channel that is neither is a
      // false claim the generator would have copied in verbatim.
      for (const channel of row.channels) {
        expect(
          sources.has(channel) || LEGACY_CHANNEL_ALIASES.has(channel),
          `${row.plugin}: claimed channel "${channel}" is neither a registration source nor a reviewed legacy alias`,
        ).toBe(true);
      }
      // Each reviewed alias must map to a real registration source of the
      // same row, so the alias table cannot outlive its plugin.
      for (const [alias, canonical] of LEGACY_CHANNEL_ALIASES) {
        if (row.channels.includes(alias)) {
          expect(
            sources.has(canonical),
            `${row.plugin}: legacy alias "${alias}" must map to registered source "${canonical}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("distinguishes outbound-only registrations from group-scope transports", () => {
    const byPlugin = new Map(
      (truthInventory.connectors as InventoryRow[]).map((r) => [r.plugin, r]),
    );
    // Gmail is send-only: capabilities are outbound-send only.
    const google = byPlugin.get("plugin-google-workspace");
    expect(google).toBeDefined();
    const gmail = (
      google?.registrations as Array<{
        source: string;
        scope: string;
        capabilities: string[];
      }>
    )?.find((r) => r.source === "gmail");
    expect(gmail).toBeDefined();
    expect(gmail?.scope).toBe("send-only");
    expect(gmail?.capabilities).toEqual(["send_message"]);
    // Google Chat carries group-scope target kinds.
    const chat = (
      google?.registrations as Array<{ source: string; scope: string }>
    )?.find((r) => r.source === "google-chat");
    expect(chat?.scope).toBe("group-scope");
    // Every group-scope connector exposes at least one group target kind.
    for (const row of truthInventory.connectors as InventoryRow[]) {
      if (row.scope === "group-scope") {
        expect(
          row.supportedTargetKinds.some((k) =>
            ["room", "channel", "thread", "group"].includes(k),
          ),
          `${row.plugin} claims group-scope without a group target kind`,
        ).toBe(true);
      }
    }
  });
});
