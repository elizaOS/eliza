/**
 * Unit coverage for the `@elizaos/ui/config` barrel (src/config/index.ts).
 * Deterministic real-module suite: drives every runtime helper the barrel
 * re-exports through its public path and pins the export surface so a
 * refactor cannot silently drop a name consumers depend on.
 */

import { describe, expect, it } from "vitest";

import type { AppConfig } from "./index";
import {
  BrandingContext,
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  builtInValidators,
  DEFAULT_APP_DISPLAY_NAME,
  DEFAULT_BOOT_CONFIG,
  DEFAULT_BRANDING,
  getBootConfig,
  getByPath,
  interpolateString,
  isConfigValuePresent,
  parseAllowedHostEnv,
  resolveAppBranding,
  resolveCharacterCatalog,
  setBootConfig,
  shouldUseCloudOnlyBranding,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
  useBranding,
} from "./index";

type UiElement = Record<string, unknown>;

/** Read a UI-spec element's props bag with a usable static shape. */
function propsOf(element: UiElement): Record<string, unknown> {
  return (element.props ?? {}) as Record<string, unknown>;
}

describe("barrel export surface", () => {
  it("resolves and exposes every runtime helper consumers import", () => {
    const runtimeExports = {
      resolveAppBranding,
      parseAllowedHostEnv,
      toViteAllowedHosts,
      toCapacitorAllowNavigation,
      shouldUseCloudOnlyBranding,
      buildPluginConfigUiSpec,
      buildPluginListUiSpec,
      DEFAULT_BRANDING,
      DEFAULT_APP_DISPLAY_NAME,
      BrandingContext,
      useBranding,
      DEFAULT_BOOT_CONFIG,
      setBootConfig,
      getBootConfig,
      resolveCharacterCatalog,
      getByPath,
      interpolateString,
      isConfigValuePresent,
      builtInValidators,
    };

    for (const [name, value] of Object.entries(runtimeExports)) {
      expect(value, `barrel dropped ${name}`).toBeDefined();
    }
    const nonFunctionExports = new Set([
      "BrandingContext",
      "builtInValidators",
    ]);
    for (const [name, value] of Object.entries(runtimeExports)) {
      if (nonFunctionExports.has(name) || name.startsWith("DEFAULT_")) continue;
      expect(typeof value, `${name} stopped being callable`).toBe("function");
    }
    expect(builtInValidators).toBeTypeOf("object");
  });
});

describe("parseAllowedHostEnv (via barrel)", () => {
  it("returns no patterns for null and undefined env values", () => {
    expect(parseAllowedHostEnv(null)).toEqual([]);
    expect(parseAllowedHostEnv(undefined)).toEqual([]);
  });

  it("parses bare hosts, origins, and subdomain wildcards from a comma list", () => {
    expect(
      parseAllowedHostEnv("example.com, https://app.example.com, *.foo.dev"),
    ).toEqual([
      { host: "example.com", includeSubdomains: false },
      { host: "app.example.com", includeSubdomains: false },
      { host: "foo.dev", includeSubdomains: true },
    ]);
  });

  it("lowercases hosts and de-duplicates repeated entries", () => {
    expect(parseAllowedHostEnv("Bar.IO, bar.io")).toEqual([
      { host: "bar.io", includeSubdomains: false },
    ]);
  });

  it("skips whitespace-only entries between commas", () => {
    expect(parseAllowedHostEnv("a.com, , b.com")).toEqual([
      { host: "a.com", includeSubdomains: false },
      { host: "b.com", includeSubdomains: false },
    ]);
  });

  it("rejects an entry containing control characters or spaces", () => {
    expect(() => parseAllowedHostEnv("bad host.com")).toThrow(
      /not a supported host pattern/,
    );
  });
});

describe("host conversion helpers (via barrel)", () => {
  it("maps wildcard entries to Vite leading-dot hosts", () => {
    expect(
      toViteAllowedHosts([
        { host: "foo.dev", includeSubdomains: true },
        { host: "bar.io", includeSubdomains: false },
      ]),
    ).toEqual([".foo.dev", "bar.io"]);
  });

  it("maps wildcard entries to Capacitor star prefixes", () => {
    expect(
      toCapacitorAllowNavigation([
        { host: "foo.dev", includeSubdomains: true },
        { host: "bar.io", includeSubdomains: false },
      ]),
    ).toEqual(["*.foo.dev", "bar.io"]);
  });
});

describe("shouldUseCloudOnlyBranding (via barrel)", () => {
  it("lets an explicit desktop cloud mode win over dev + injected backend", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        injectedApiBase: "http://127.0.0.1:3000",
        desktopRuntimeMode: "cloud",
      }),
    ).toBe(true);
  });

  it("matches the elizacloud desktop mode case-insensitively despite padding", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: true,
        desktopRuntimeMode: "  ELIZACLOUD ",
      }),
    ).toBe(true);
  });

  it("stays out of cloud-only branding while running dev without opt-in", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: true })).toBe(false);
  });

  it("follows an injected production backend instead of the web preset", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        injectedApiBase: "http://10.0.0.5:3000",
      }),
    ).toBe(false);
  });

  it("uses the cloud-only preset for plain production web", () => {
    expect(shouldUseCloudOnlyBranding({ isDev: false })).toBe(true);
  });

  it("on native platforms follows the native runtime mode alone", () => {
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: "cloud",
      }),
    ).toBe(true);
    expect(
      shouldUseCloudOnlyBranding({
        isDev: false,
        isNativePlatform: true,
        nativeRuntimeMode: null,
      }),
    ).toBe(false);
  });
});

describe("resolveAppBranding (via barrel)", () => {
  const appConfig: AppConfig = {
    appName: "Nexa",
    appId: "app.nexa",
    orgName: "nexa-org",
    repoName: "nexa-repo",
    cliName: "nexa",
    description: "Nexa agents",
    branding: {},
  };

  it("layers app identity over the framework defaults", () => {
    const branding = resolveAppBranding(appConfig);
    expect(branding.appName).toBe("Nexa");
    expect(branding.orgName).toBe("nexa-org");
    expect(branding.repoName).toBe("nexa-repo");
    expect(branding.fileExtension).toBe(".eliza-agent");
  });

  it("lets appConfig.branding win over both defaults and app identity", () => {
    const branding = resolveAppBranding({
      ...appConfig,
      branding: { appName: "Nexa Pro", hashtag: "#Nexa" },
    });
    expect(branding.appName).toBe("Nexa Pro");
    expect(branding.orgName).toBe("nexa-org");
    expect(branding.hashtag).toBe("#Nexa");
  });
});

describe("boot-config store (via barrel)", () => {
  it("seeds the process-global store with the documented defaults", () => {
    expect(getBootConfig()).toEqual(DEFAULT_BOOT_CONFIG);
    expect(DEFAULT_BOOT_CONFIG.cloudApiBase).toBe("https://eliza.app");
    expect(DEFAULT_BOOT_CONFIG.preferSharedCloudTier).toBe(true);
    expect(DEFAULT_BOOT_CONFIG.autoUpgradeSharedToDedicated).toBe(false);
  });

  it("stores a host-provided config and mirrors it on globalThis", () => {
    const custom = {
      ...DEFAULT_BOOT_CONFIG,
      cloudApiBase: "https://boot.example",
    };
    try {
      setBootConfig(custom);
      expect(getBootConfig()).toBe(custom);
      expect(
        (globalThis as { __ELIZAOS_APP_BOOT_CONFIG__?: unknown })
          .__ELIZAOS_APP_BOOT_CONFIG__,
      ).toBe(custom);
    } finally {
      setBootConfig(DEFAULT_BOOT_CONFIG);
    }
  });
});

describe("buildPluginConfigUiSpec (via barrel)", () => {
  const basePlugin = { id: "plugin-a", name: "Plugin A" };

  it("marks an enabled plugin whose required params are set as Ready", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: true,
      parameters: [{ key: "endpoint", required: true, isSet: true }],
    });
    expect(spec.version).toBe(1);
    expect(spec.root).toBe("root");
    expect(spec.state.pluginId).toBe("plugin-a");
    expect(propsOf(spec.elements.title).text).toBe("Configure Plugin A");
    expect(propsOf(spec.elements.status)).toMatchObject({
      text: "Ready",
      variant: "default",
    });
  });

  it("flags an enabled plugin with an unset required param", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: true,
      parameters: [{ key: "apiKey", required: true, isSet: false }],
    });
    expect(propsOf(spec.elements.status)).toMatchObject({
      text: "Needs Configuration",
      variant: "secondary",
    });
  });

  it("renders a disabled plugin with an Enable Plugin button", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: false,
      parameters: [],
    });
    expect(propsOf(spec.elements.status)).toMatchObject({
      text: "Disabled",
      variant: "outline",
    });
    expect(spec.elements.enableBtn).toBeDefined();
  });

  it("adds a Test Connection button for connectors", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: true,
      category: "connector",
      parameters: [],
    });
    const testButton = propsOf(spec.elements.testBtn);
    expect(testButton.text).toBe("Test Connection");
    const onPress = testButton.on as {
      press: { action: string; params: { pluginId: string } };
    };
    expect(onPress.press.action).toBe("plugin:test");
    expect(onPress.press.params.pluginId).toBe("plugin-a");
  });

  it("masks secret params and reports already-set placeholders", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: true,
      parameters: [
        { key: "API_KEY", required: true, isSet: true, label: "API Key" },
      ],
    });
    const field = propsOf(spec.elements.field_API_KEY);
    expect(field.type).toBe("password");
    expect(field.label).toBe("API Key");
    expect(field.placeholder).toContain("(already set)");
  });

  it("routes the save action back to the owning plugin id", () => {
    const spec = buildPluginConfigUiSpec({
      ...basePlugin,
      enabled: true,
      parameters: [],
    });
    const onPress = propsOf(spec.elements.saveBtn).on as {
      press: { action: string; params: { pluginId: string } };
    };
    expect(onPress.press.action).toBe("plugin:save");
    expect(onPress.press.params.pluginId).toBe("plugin-a");
  });
});

describe("buildPluginListUiSpec (via barrel)", () => {
  it("titles the list and renders one name element per plugin", () => {
    const spec = buildPluginListUiSpec(
      [
        { id: "p1", name: "First", parameters: [] },
        { id: "p2", name: "Second", parameters: [] },
      ],
      "Available plugins",
    );
    expect(propsOf(spec.elements.heading)).toMatchObject({
      level: 3,
      text: "Available plugins",
    });
    expect(propsOf(spec.elements.name_0).text).toBe("First");
    expect(propsOf(spec.elements.name_1).text).toBe("Second");
    expect(spec.elements.name_2).toBeUndefined();
  });

  it("keeps the heading for an empty plugin list", () => {
    const spec = buildPluginListUiSpec([], "No plugins");
    expect(propsOf(spec.elements.heading).text).toBe("No plugins");
    expect(spec.elements.name_0).toBeUndefined();
  });
});

describe("config-catalog plumbing (via barrel)", () => {
  it("reads nested values by slash-delimited path", () => {
    expect(getByPath({ a: { b: "value" } }, "a/b")).toBe("value");
    expect(getByPath({ a: { b: "value" } }, "a.b")).toBeUndefined();
    expect(getByPath({ a: 1 }, "a/b/c")).toBeUndefined();
  });
});
