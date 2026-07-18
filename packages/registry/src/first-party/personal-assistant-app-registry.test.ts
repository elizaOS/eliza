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
        runtimeHook: {
          specifier: "@elizaos/plugin-personal-assistant/register-runtime",
          exportName: "registerPersonalAssistantRuntimeHooks",
        },
      },
    });
  });
});
