import type { Action, Plugin } from "@elizaos/core";
import { todosPlugin } from "@elizaos/plugin-todos";
import { describe, expect, it } from "vitest";
import {
  nativeOwnedSurfacePolicy,
  PERSONAL_ASSISTANT_PLUGIN_NAME,
  withholdNativeOwnedSurfaces,
} from "./native-owned-surfaces.ts";

const action = (name: string) => ({ name }) as Action;

const personalAssistant: Plugin = {
  name: PERSONAL_ASSISTANT_PLUGIN_NAME,
  description: "owner surfaces",
  actions: [
    "OWNER_REMINDERS",
    "OWNER_REMINDERS_CREATE",
    "OWNER_REMINDERS_DELETE",
    "OWNER_ALARMS",
    "OWNER_ALARMS_CREATE",
    "OWNER_ALARMS_DELETE",
    "OWNER_TODOS",
    "OWNER_TODOS_CREATE",
    "OWNER_ROUTINES",
    "SCHEDULED_TASKS",
    "BRIEF",
  ].map(action),
};

const remindersPlugin: Plugin = {
  name: "@elizaos/plugin-personal-assistant/reminders-plugin",
  description: "owner reminders",
  actions: ["OWNER_REMINDERS", "OWNER_REMINDERS_CREATE"].map(action),
};

function registered(
  plugins: Plugin[],
  env: Record<string, string | undefined>,
  loaded = plugins.map((plugin) => plugin.name),
) {
  const policy = nativeOwnedSurfacePolicy(new Set(loaded), env);
  const projected = plugins.map((plugin) =>
    withholdNativeOwnedSurfaces(plugin, policy),
  );
  return {
    projected,
    actions: projected.flatMap((plugin) =>
      (plugin.actions ?? []).map((value) => value.name),
    ),
    providers: projected.flatMap((plugin) =>
      (plugin.providers ?? []).map((value) => value.name),
    ),
  };
}

describe("native-owned owner surfaces", () => {
  it("withholds alarm and reminder owners named by the host setting", () => {
    const { actions } = registered([personalAssistant, remindersPlugin], {
      ELIZA_NATIVE_OWNED_DOMAINS: "alarms, reminders",
    });
    expect(
      actions.filter(
        (name) =>
          name.startsWith("OWNER_ALARMS") || name.startsWith("OWNER_REMINDERS"),
      ),
    ).toEqual([]);
    // The rest of the assistant stays registered.
    expect(actions).toEqual(
      expect.arrayContaining([
        "OWNER_TODOS",
        "OWNER_ROUTINES",
        "SCHEDULED_TASKS",
        "BRIEF",
      ]),
    );
  });

  it("keeps today's owner surfaces without the setting", () => {
    const { projected } = registered([personalAssistant, remindersPlugin], {});
    expect(projected[0]).toBe(personalAssistant);
    expect(projected[1]).toBe(remindersPlugin);
  });

  it("does not mutate the plugin descriptor it filters", () => {
    registered([personalAssistant], {
      ELIZA_NATIVE_OWNED_DOMAINS: "alarms",
    });
    expect(personalAssistant.actions?.map((value) => value.name)).toContain(
      "OWNER_ALARMS",
    );
  });

  it("registers one agent to-do owner when the personal assistant loads", () => {
    const { actions, providers, projected } = registered(
      [personalAssistant, todosPlugin],
      {},
    );
    expect(actions.filter((name) => /^(?:OWNER_)?TODOS?$/.test(name))).toEqual([
      "OWNER_TODOS",
    ]);
    expect(providers).not.toContain("CURRENT_TODOS");
    // The to-do view stays available.
    expect(projected[1]?.views).toBe(todosPlugin.views);
  });

  it("decides the to-do owner from the whole load set, not the phase", () => {
    const { actions } = registered([todosPlugin], {}, [
      "todos",
      PERSONAL_ASSISTANT_PLUGIN_NAME,
    ]);
    expect(actions).not.toContain("TODO");
  });

  it("keeps plugin-todos as the owner without the personal assistant", () => {
    const { projected } = registered([todosPlugin], {});
    expect(projected[0]).toBe(todosPlugin);
  });

  it("withholds both to-do stores when the host owns to-dos", () => {
    const { actions, providers } = registered(
      [personalAssistant, todosPlugin],
      { ELIZA_NATIVE_OWNED_DOMAINS: "todos" },
    );
    expect(actions.filter((name) => name.includes("TODO"))).toEqual([]);
    expect(providers).not.toContain("CURRENT_TODOS");
  });
});
