/** Verifies the hidden LifeOps route app is discoverable through the first-party registry. */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegistryCacheForTests,
  getEntryByNpmName,
  loadRegistry,
} from "./index";

describe("personal-assistant app registry entry", () => {
  afterEach(() => {
    clearRegistryCacheForTests();
  });

  it("exposes the hidden LifeOps route plugin through the static app catalog", () => {
    const entry = getEntryByNpmName(
      loadRegistry(),
      "@elizaos/plugin-personal-assistant",
    );

    expect(entry?.kind).toBe("app");
    if (entry?.kind !== "app") {
      throw new Error("Expected personal-assistant to be an app entry");
    }

    expect(entry).toMatchObject({
      id: "personal-assistant",
      kind: "app",
      name: "LifeOps",
      npmName: "@elizaos/plugin-personal-assistant",
      shortIds: ["selfcontrol"],
      render: {
        visible: false,
        actions: [],
      },
      launch: {
        type: "server-launch",
        capabilities: expect.arrayContaining(["lifeops", "goals", "todos"]),
        routePlugin: {
          specifier: "@elizaos/plugin-personal-assistant/routes/plugin",
          exportName: "personalAssistantRoutesPlugin",
        },
      },
    });
  });

  it("sorts curated app definitions safely when order contains NaN", async () => {
    const { collectCuratedAppDefinitions } = await import("./generate");
    const entries = [
      {
        npmName: "pkg-nan",
        curatedApp: { slug: "app-nan", order: NaN, aliases: [] },
      },
      {
        npmName: "pkg-a",
        curatedApp: { slug: "app-a", order: 5, aliases: [] },
      },
    ];

    const result = collectCuratedAppDefinitions(entries as never);
    expect(result).toHaveLength(2);
    expect(result[0]?.slug).toBe("app-nan");
    expect(result[1]?.slug).toBe("app-a");
  });
});
