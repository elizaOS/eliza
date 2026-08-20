/**
 * Covers the design service's adapter registry, capability routing, provider
 * response binding, settings-driven local-mode startup, and the managed-mode
 * eligibility gate. Deterministic; adapters are in-memory doubles for the
 * registry seams while the settings path builds the real adapters.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { DesignProviderAdapter } from "./adapter.js";
import { DesignError } from "./errors.js";
import { DesignService, MANAGED_DESIGN_ELIGIBILITY } from "./service.js";
import type { DesignCapability, DesignRef } from "./types.js";

function stubRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

function design(provider: string): DesignRef {
  return {
    provider,
    providerDesignId: "d-1",
    name: "Poster",
    deepLinkUrl: "https://www.figma.com/design/d-1",
  };
}

function fakeAdapter(
  id: string,
  overrides: Partial<DesignProviderAdapter> = {},
): DesignProviderAdapter {
  return {
    id,
    connectionId: `conn_${id.padEnd(4, "x")}_abcdefghij123456`,
    capabilities: new Set<DesignCapability>([
      "search",
      "get",
      "export",
      "comments",
    ]),
    searchDesigns: async () => ({ designs: [design(id)], nextCursor: null }),
    getDesign: async () => design(id),
    exportDesign: async () => ({
      provider: id,
      providerDesignId: "d-1",
      format: "png" as const,
      urls: ["https://example-cdn.test/render.png"],
    }),
    listComments: async () => ({ comments: [], nextCursor: null }),
    ...overrides,
  };
}

async function expectCode(
  operation: Promise<unknown> | (() => unknown),
  code: DesignError["code"],
): Promise<void> {
  try {
    await (typeof operation === "function" ? operation() : operation);
  } catch (error) {
    // error-policy:J1 The test assertion boundary verifies the typed failure
    // instead of allowing it to escape the case.
    expect(error).toBeInstanceOf(DesignError);
    expect((error as DesignError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("DesignService", () => {
  it("starts with no adapters and fails requests with a typed not-connected error", async () => {
    const service = await DesignService.start(stubRuntime({}));
    expect(service.listAdapters()).toEqual([]);
    await expectCode(
      service.searchDesigns({ query: "poster" }),
      "DESIGN_NOT_CONNECTED",
    );
    await expectCode(service.getDesign("d-1", "figma"), "DESIGN_NOT_CONNECTED");
  });

  it("builds local-mode adapters only from explicit settings, never a Cloud fallback", async () => {
    const figmaOnly = await DesignService.start(
      stubRuntime({ FIGMA_PERSONAL_ACCESS_TOKEN: "figd_local" }),
    );
    expect(figmaOnly.listAdapters()).toEqual(["figma"]);

    const both = await DesignService.start(
      stubRuntime({
        FIGMA_PERSONAL_ACCESS_TOKEN: "figd_local",
        FIGMA_PROJECT_ID: "123",
        CANVA_ACCESS_TOKEN: "canva_local",
      }),
    );
    expect(both.listAdapters()).toEqual(["figma", "canva"]);

    const blank = await DesignService.start(
      stubRuntime({ FIGMA_PERSONAL_ACCESS_TOKEN: "   " }),
    );
    expect(blank.listAdapters()).toEqual([]);
  });

  it("keeps managed Cloud mode a typed ineligible state for both providers", async () => {
    const service = await DesignService.start(stubRuntime({}));
    for (const provider of ["canva", "figma"] as const) {
      expect(service.managedEligibility(provider)).toEqual(
        MANAGED_DESIGN_ELIGIBILITY[provider],
      );
      expect(MANAGED_DESIGN_ELIGIBILITY[provider].eligible).toBe(false);
      await expectCode(
        () => service.connectManaged(provider),
        "DESIGN_MANAGED_MODE_INELIGIBLE",
      );
    }
  });

  it("rejects adapters with invalid identity or non-opaque connection ids", async () => {
    const service = await DesignService.start(stubRuntime({}));
    await expectCode(
      () => service.registerAdapter(fakeAdapter("bad id!")),
      "DESIGN_INVALID_INPUT",
    );
    await expectCode(
      () =>
        service.registerAdapter(
          fakeAdapter("figma", { connectionId: "figd_raw_token_value" }),
        ),
      "DESIGN_INVALID_INPUT",
    );
  });

  it("routes by provider, enforces capabilities, and re-defaults on unregister", async () => {
    const service = await DesignService.start(stubRuntime({}));
    service.registerAdapter(fakeAdapter("figma"));
    service.registerAdapter(
      fakeAdapter("canva", {
        capabilities: new Set<DesignCapability>(["search", "get", "export"]),
        searchDesigns: async () => ({
          designs: [
            {
              ...design("canva"),
              deepLinkUrl: "https://www.canva.com/design/d-1/view",
            },
          ],
          nextCursor: null,
        }),
      }),
    );

    const page = await service.searchDesigns({ query: "poster" }, "canva");
    expect(page.designs[0]?.provider).toBe("canva");
    await expectCode(
      service.listComments("d-1", "canva"),
      "DESIGN_UNSUPPORTED",
    );

    service.unregisterAdapter("figma");
    const defaulted = await service.searchDesigns({ query: "poster" });
    expect(defaulted.designs[0]?.provider).toBe("canva");
    service.unregisterAdapter("canva");
    await expectCode(
      service.searchDesigns({ query: "poster" }),
      "DESIGN_NOT_CONNECTED",
    );
  });

  it("rejects provider-spoofed responses and invalid provider payloads", async () => {
    const service = await DesignService.start(stubRuntime({}));
    service.registerAdapter(
      fakeAdapter("figma", {
        searchDesigns: async () => ({
          designs: [design("canva")],
          nextCursor: null,
        }),
      }),
    );
    await expectCode(
      service.searchDesigns({ query: "poster" }),
      "DESIGN_MALFORMED_RESPONSE",
    );

    service.registerAdapter(
      fakeAdapter("figma", {
        exportDesign: async () =>
          ({
            provider: "figma",
            providerDesignId: "d-1",
            format: "png",
            urls: ["http://insecure.example.test/render.png"],
          }) as never,
      }),
      true,
    );
    await expectCode(
      service.exportDesign({ providerDesignId: "d-1", format: "png" }),
      "DESIGN_INVALID_INPUT",
    );
  });

  it("stops cleanly and clears registered adapters", async () => {
    const service = await DesignService.start(stubRuntime({}));
    service.registerAdapter(fakeAdapter("figma"));
    await service.stop();
    expect(service.listAdapters()).toEqual([]);
    await expectCode(
      service.searchDesigns({ query: "poster" }),
      "DESIGN_NOT_CONNECTED",
    );
  });
});
