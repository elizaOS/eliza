/** Exercises deterministic server authority over renderer-supplied view metadata without replacing the runtime action gates. */

import type { ViewDeclaration } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  enrichChatUiViewMetadata,
  resolveChatMetadataView,
} from "./chat-view-metadata.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

function view(declaration: ViewDeclaration): ViewRegistryEntry {
  return {
    ...declaration,
    viewType: "gui",
    pluginName: `test:${declaration.id}`,
    hasHeroImage: false,
    available: true,
    loadedAt: 1,
    platform: "web",
  };
}

const VIEWS = [
  view({ id: "chat", label: "Chat", path: "/chat" }),
  view({
    id: "health",
    label: "Health",
    path: "/health",
    relatedActions: ["OWNER_HEALTH", "OWNER_SCREENTIME"],
    capabilities: [
      { id: "read-summary", description: "Read the health summary" },
      {
        id: "human-only-control",
        description: "A human-only control",
        authority: "human",
      },
    ],
    responseContext: {
      primaryContext: "health",
      secondaryContexts: ["documents"],
    },
    scopedActions: [
      {
        name: "HEALTH_OPEN_DETAIL",
        description: "Open a health detail",
        steps: [{ kind: "agent-click", target: "detail" }],
      },
    ],
  }),
  view({
    id: "health-detail",
    label: "Health Detail",
    path: "/health/detail",
    relatedActions: ["HEALTH_DETAIL"],
  }),
];

describe("chat view metadata", () => {
  it("resolves the most-specific registered route before a generic renderer id", () => {
    expect(
      resolveChatMetadataView(
        { uiView: "apps", uiViewPath: "/health/detail/day" },
        VIEWS,
      )?.id,
    ).toBe("health-detail");
  });

  it("publishes registry-owned view, capability, and action facts", () => {
    expect(
      enrichChatUiViewMetadata(
        {
          uiView: "apps",
          uiViewPath: "/health/today?from=home",
          uiViewCapabilities: ["generic-view-action"],
          uiViewActionNames: ["EVM_TRANSFER"],
          keep: "caller-data",
        },
        VIEWS,
      ),
    ).toEqual({
      uiView: "health",
      uiViewPath: "/health/today",
      uiViewCapabilities: ["read-summary"],
      uiViewActionNames: [
        "OWNER_HEALTH",
        "OWNER_SCREENTIME",
        "HEALTH_OPEN_DETAIL",
      ],
      __responseContext: {
        primaryContext: "health",
        secondaryContexts: ["documents"],
      },
      keep: "caller-data",
    });
  });

  it("clears renderer hints when a registered view declares no capabilities", () => {
    expect(
      enrichChatUiViewMetadata(
        {
          uiView: "chat",
          uiViewPath: "/chat",
          uiViewCapabilities: ["general-chat"],
        },
        VIEWS,
      ),
    ).toMatchObject({
      uiView: "chat",
      uiViewCapabilities: [],
      uiViewActionNames: [],
    });
  });

  it("does not trust renderer response context when the registry declares none", () => {
    const neutralView = view({
      id: "neutral",
      label: "Neutral",
      path: "/neutral",
    });
    expect(
      enrichChatUiViewMetadata(
        {
          uiView: "neutral",
          uiViewPath: "/neutral",
          __responseContext: { primaryContext: "secrets" },
        },
        [...VIEWS, neutralView],
      ),
    ).toEqual({
      uiView: "neutral",
      uiViewPath: "/neutral",
      uiViewCapabilities: [],
      uiViewActionNames: [],
    });
  });

  it("replaces a tampered response context with the registry declaration", () => {
    expect(
      enrichChatUiViewMetadata(
        {
          uiView: "health",
          uiViewPath: "/health",
          __responseContext: {
            primaryContext: "wallet",
            secondaryContexts: ["trading"],
          },
        },
        VIEWS,
      ),
    ).toMatchObject({
      __responseContext: {
        primaryContext: "health",
        secondaryContexts: ["documents"],
      },
    });
  });

  it("does not reinterpret non-renderer or unknown-view metadata", () => {
    const apiMetadata = { requestId: "r1" };
    const unknown = {
      uiView: "unknown",
      uiViewPath: "/unknown",
      uiViewCapabilities: ["transfer-funds"],
      uiViewActionNames: ["EVM_TRANSFER"],
      requestId: "r2",
    };
    expect(enrichChatUiViewMetadata(apiMetadata, VIEWS)).toBe(apiMetadata);
    expect(enrichChatUiViewMetadata(unknown, VIEWS)).toEqual({
      requestId: "r2",
    });
  });

  it("neutralizes unavailable views and their claimed response context", () => {
    const unavailable = view({
      id: "notes",
      label: "Notes",
      path: "/notes",
      capabilities: [{ id: "read-notes", description: "Read notes" }],
    });
    unavailable.available = false;

    expect(
      enrichChatUiViewMetadata(
        {
          uiView: "notes",
          uiViewPath: "/notes",
          uiViewCapabilities: ["read-notes"],
          __responseContext: {
            primaryContext: "notes",
            secondaryContexts: ["notes"],
          },
          uiTab: "views",
        },
        [...VIEWS, unavailable],
      ),
    ).toEqual({ uiTab: "views" });
  });

  it("strips action names when no authoritative renderer view resolves", () => {
    expect(
      enrichChatUiViewMetadata(
        { requestId: "r3", uiViewActionNames: ["EVM_TRANSFER"] },
        VIEWS,
      ),
    ).toEqual({ requestId: "r3" });
  });
});
