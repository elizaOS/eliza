/**
 * Guards the app-core Node ↔ @elizaos/ui decoupling (#12410). Statically scans
 * the Node-reachable API/service modules to prove none import React UI
 * internals, checks the moved registration surfaces resolve from
 * @elizaos/shared with behavior identical to the old `@elizaos/ui` surface, and
 * asserts the `@elizaos/ui` package no longer publishes a broad `./*` wildcard
 * export. Runs against the real source tree and the real @elizaos/shared
 * implementation — no mocks.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AutomationNodeCatalogResponse,
  type AutomationNodeDescriptor,
  DEFAULT_UI_LANGUAGE,
  isElizaOS,
  normalizeLanguage,
  UI_LANGUAGES,
  userAgentHasElizaOSMarker,
} from "@elizaos/shared";
import { normalizeLanguage as uiNormalizeLanguage } from "@elizaos/ui/i18n";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

// Modules that are reachable from the Node `@elizaos/app-core` barrel / the API
// server graph. None of these may import the React UI barrel or its
// renderer-only sub-surfaces (`i18n`, `platform`).
const NODE_REACHABLE_SOURCES = [
  "packages/app-core/src/api/i18n-locale-routes.ts",
  "packages/app-core/src/api/automation-node-contributors.ts",
  "packages/app-core/src/api/automation-action-classifier.ts",
  "packages/app-core/src/api/automations-compat-routes.ts",
  "packages/app-core/src/services/app-updates/update-policy.ts",
];

// Import specifiers a Node-reachable module must never carry, because they pull
// (or transitively evaluate) the renderer graph (Capacitor bridges, lucide
// icons, message dictionaries).
const FORBIDDEN_UI_SPECIFIERS = [
  '"@elizaos/ui"',
  '"@elizaos/ui/i18n"',
  '"@elizaos/ui/platform"',
];

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("app-core Node modules stay decoupled from React UI internals", () => {
  for (const rel of NODE_REACHABLE_SOURCES) {
    it(`${rel} imports no React UI internals`, () => {
      const source = readSource(rel);
      for (const specifier of FORBIDDEN_UI_SPECIFIERS) {
        // Only flag real import/export-from statements, not prose in comments.
        const importPattern = new RegExp(
          `(?:import|export)[^;]*from\\s+${specifier.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`,
        );
        expect(
          importPattern.test(source),
          `${rel} must not import from ${specifier}`,
        ).toBe(false);
      }
    });
  }
});

describe("moved registration surfaces resolve from @elizaos/shared", () => {
  it("re-exports language normalization identically to @elizaos/ui/i18n", () => {
    const samples = [
      "en",
      "en-US",
      "zh",
      "zh-CN",
      "zh-Hans-CN",
      "ko-KR",
      "pt-BR",
      "fil-PH",
      "  ja  ",
      "xx-unknown",
      "",
      42,
      null,
      undefined,
    ];
    for (const sample of samples) {
      expect(normalizeLanguage(sample)).toBe(uiNormalizeLanguage(sample));
    }
    expect(normalizeLanguage("de")).toBe(DEFAULT_UI_LANGUAGE);
    expect(UI_LANGUAGES).toContain("en");
  });

  it("detects the AOSP ElizaOS user-agent marker", () => {
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 ElizaOS/2.0 (Linux)")).toBe(
      true,
    );
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 (Linux; Android 14)")).toBe(
      false,
    );
    expect(userAgentHasElizaOSMarker(null)).toBe(false);
  });

  it("isElizaOS() is false in a Node process (userAgent lacks the marker)", () => {
    // Node 24 exposes a global `navigator`, but its userAgent (e.g. "Node.js/24")
    // never carries the AOSP `ElizaOS/<tag>` marker, so a Node API process is
    // correctly not detected as an ElizaOS system image.
    expect(isElizaOS()).toBe(false);
  });

  it("exposes the automation-node catalog contract as a typed shape", () => {
    const descriptor: AutomationNodeDescriptor = {
      id: "n1",
      label: "Send message",
      description: "",
      class: "action",
      source: "core",
      backingCapability: "SEND_MESSAGE",
      ownerScoped: false,
      requiresSetup: false,
      availability: "enabled",
    };
    const catalog: AutomationNodeCatalogResponse = {
      nodes: [descriptor],
      summary: { total: 1, enabled: 1, disabled: 0 },
    };
    expect(catalog.nodes[0].class).toBe("action");
  });
});

describe("@elizaos/ui export map has no broad wildcard", () => {
  it("does not publish a catch-all ./* export for internal files", () => {
    const pkg = JSON.parse(readSource("packages/ui/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./*"]).toBeUndefined();
  });

  it("keeps curated entrypoints the desktop shell + app-core rely on", () => {
    const pkg = JSON.parse(readSource("packages/ui/package.json")) as {
      exports: Record<string, unknown>;
    };
    for (const entry of [
      "./App",
      "./browser",
      "./build-variant",
      "./navigation",
      "./i18n",
      "./platform",
      "./app-shell-registry",
      "./utils/*",
      "./services/*",
    ]) {
      expect(
        pkg.exports[entry],
        `@elizaos/ui must export ${entry}`,
      ).toBeDefined();
    }
  });
});
