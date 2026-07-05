/**
 * View-scoped agent actions: a view's `scopedActions` become real runtime
 * actions gated on the declaring view being active, driving that view's
 * `useAgentElement` controls through the EXISTING interact protocol. Exercises
 * the real path — registers a view in the live views-registry, flips the active
 * view via the actual POST /api/views/:id/navigate route handler, and dispatches
 * scoped-action steps through the shared views-routes dispatch (serverInteract
 * branch stands in for the mounted shell's agent-surface registry). No mock of
 * the unit under test: validate() reads the real active-view context and the
 * handler runs the real dispatch + missing-element detection.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import type { Action, IAgentRuntime, ViewScopedAction } from "@elizaos/core";
import { type ElizaError, isElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_VIEWS } from "../api/builtin-views.ts";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  setViewsBroadcastWs,
  type ViewsRouteContext,
} from "../api/views-routes.ts";
import { clearActiveViewContext } from "./view-action-affinity.ts";
import {
  __resetViewScopedActionRegistryForTests,
  buildViewScopedAction,
  registerViewScopedActions,
  scopedActionNames,
  unregisterViewScopedActions,
} from "./view-scoped-actions.ts";

const TEST_PLUGIN = "@test/view-scoped-actions";
const INTERACTIVE_VIEW_ID = "settings_fixture";

/**
 * Mounted view whose serverInteract stands in for the shell's agent-surface
 * registry: `agent-fill`/`agent-click`/`agent-focus` succeed against the ids in
 * `mountedIds`, and report `{ ok: false, reason: "element not found" }` for any
 * other id — exactly what the real registry returns for an unmounted element.
 */
function makeInteractiveView(id: string, mountedIds: Set<string>) {
  const filled: Record<string, string> = {};
  const clicked: string[] = [];
  return {
    filled,
    clicked,
    view: {
      id,
      label: `${id} view`,
      path: `/${id}`,
      surface: { capabilities: ["agent-surface"] },
      relatedActions: [] as string[],
      scopedActions: [
        {
          name: `VIEW_${id.toUpperCase()}_SET_PROVIDER`,
          description: `Set the provider on the ${id} view`,
          parameters: ["provider"],
          steps: [
            { kind: "agent-focus" as const, target: "provider-select" },
            {
              kind: "agent-fill" as const,
              target: "provider-select",
              value: "{{provider}}",
            },
            { kind: "agent-click" as const, target: "save-button" },
          ],
        },
        {
          name: `VIEW_${id.toUpperCase()}_MISSING_TARGET`,
          description: "Drives an element that is not mounted",
          steps: [{ kind: "agent-click" as const, target: "ghost-button" }],
        },
      ],
      serverInteract: async (
        capability: string,
        params?: Record<string, unknown>,
      ) => {
        const targetId = typeof params?.id === "string" ? params.id : "";
        if (!mountedIds.has(targetId)) {
          return { ok: false, id: targetId, reason: "element not found" };
        }
        if (capability === "agent-fill") {
          filled[targetId] =
            typeof params?.value === "string" ? params.value : "";
          return { ok: true, id: targetId, value: filled[targetId] };
        }
        if (capability === "agent-click") {
          clicked.push(targetId);
        }
        return { ok: true, id: targetId };
      },
    },
  };
}

/** Drive the REAL navigate route so setActiveViewContext runs as it does live. */
async function navigateTo(id: string): Promise<void> {
  const req = Readable.from([
    Buffer.from(JSON.stringify({})),
  ]) as unknown as http.IncomingMessage;
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  const ctx: ViewsRouteContext = {
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
  };
  await handleViewsRoutes(ctx);
}

/**
 * Minimal runtime whose registerAction/unregisterAction mutate a name→action
 * map, so the test can register scoped actions and then invoke the real
 * validate()/handler() the mechanism built.
 */
function makeRuntime(): {
  runtime: Pick<
    IAgentRuntime,
    "actions" | "registerAction" | "unregisterAction"
  >;
  actions: Map<string, Action>;
} {
  const actions = new Map<string, Action>();
  const actionList: Action[] = [];
  return {
    actions,
    runtime: {
      actions: actionList,
      registerAction: (action: Action) => {
        if (actions.has(action.name)) return;
        actions.set(action.name, action);
        actionList.push(action);
      },
      unregisterAction: (name: string) => {
        const removed = actions.delete(name);
        const index = actionList.findIndex((action) => action.name === name);
        if (index >= 0) actionList.splice(index, 1);
        return removed;
      },
    } as Pick<IAgentRuntime, "actions" | "registerAction" | "unregisterAction">,
  };
}

const fakeMessage = {} as never;

beforeEach(async () => {
  __resetViewScopedActionRegistryForTests();
  clearCurrentViewState();
  clearActiveViewContext();
  // Give the module a broadcaster so the "no shell to reach" guard never fires
  // in this test — the mounted serverInteract is what actually resolves steps.
  setViewsBroadcastWs(() => {});
});

afterEach(() => {
  unregisterPluginViews(TEST_PLUGIN);
  clearCurrentViewState();
  clearActiveViewContext();
  setViewsBroadcastWs(null);
  __resetViewScopedActionRegistryForTests();
  vi.restoreAllMocks();
});

describe("view-scoped action validate() gating on the active view", () => {
  it("returns false when the declaring view is not active and true when it is", async () => {
    const settings = makeInteractiveView(INTERACTIVE_VIEW_ID, new Set());
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      process.cwd(),
    );
    const action = buildViewScopedAction(
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );

    // No active view → gated closed.
    expect(await action.validate({} as IAgentRuntime, fakeMessage)).toBe(false);

    // Switch to a DIFFERENT view → still closed.
    await navigateTo("chat");
    expect(await action.validate({} as IAgentRuntime, fakeMessage)).toBe(false);

    // Switch INTO the declaring view via the real navigate route → open.
    await navigateTo(INTERACTIVE_VIEW_ID);
    expect(await action.validate({} as IAgentRuntime, fakeMessage)).toBe(true);

    // Switch away again → closes without any restart.
    await navigateTo("chat");
    expect(await action.validate({} as IAgentRuntime, fakeMessage)).toBe(false);
  });
});

describe("view-scoped action handler drives the interact protocol", () => {
  it("resolves a named action to the real agent-fill/click sequence", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select", "save-button"]),
    );
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      process.cwd(),
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    const action = buildViewScopedAction(
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    const result = await action.handler(
      {} as IAgentRuntime,
      fakeMessage,
      undefined,
      { parameters: { provider: "anthropic" } },
    );

    expect(result?.success).toBe(true);
    // The fill drove the real serverInteract with the resolved param value…
    expect(settings.filled["provider-select"]).toBe("anthropic");
    // …and the click step ran.
    expect(settings.clicked).toContain("save-button");
    // The step trace is reported for observability.
    expect(result?.data?.steps).toEqual([
      "agent-focus:provider-select",
      "agent-fill:provider-select",
      "agent-click:save-button",
    ]);
  });

  it("throws a typed missing-element error when a target useAgentElement id is not mounted", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select"]),
    );
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      process.cwd(),
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    // The MISSING_TARGET action clicks "ghost-button", which is never mounted.
    const action = buildViewScopedAction(
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[1],
    );

    let thrown: unknown;
    try {
      await action.handler({} as IAgentRuntime, fakeMessage, undefined, {});
    } catch (err) {
      thrown = err;
    }
    expect(isElizaError(thrown)).toBe(true);
    const elizaErr = thrown as ElizaError;
    expect(elizaErr.code).toBe("VIEW_SCOPED_ACTION_ELEMENT_MISSING");
    expect(elizaErr.context?.target).toBe("ghost-button");
    expect(elizaErr.message).toContain("not mounted");
  });

  it("throws a typed param-missing error when a {{param}} value is not supplied", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select", "save-button"]),
    );
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      process.cwd(),
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    const action = buildViewScopedAction(
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    // No `provider` param → the {{provider}} fill step must fail loudly, not
    // fill an empty string into the real control.
    await expect(
      action.handler({} as IAgentRuntime, fakeMessage, undefined, {
        parameters: {},
      }),
    ).rejects.toMatchObject({ code: "VIEW_SCOPED_ACTION_PARAM_MISSING" });
    // The control was never touched.
    expect(settings.filled["provider-select"]).toBeUndefined();
  });

  it("throws VIEW_SCOPED_ACTION_VIEW_INACTIVE when invoked while its view is not active", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select", "save-button"]),
    );
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      process.cwd(),
    );
    // Navigate to a different view so the handler's defense-in-depth gate fires
    // even though the executor would normally block on validate().
    await navigateTo("chat");

    const action = buildViewScopedAction(
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    await expect(
      action.handler({} as IAgentRuntime, fakeMessage, undefined, {
        parameters: { provider: "anthropic" },
      }),
    ).rejects.toMatchObject({ code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE" });
  });
});

describe("view-scoped action registration reconciliation", () => {
  it("registers a view's scoped actions and unregisters exactly its set", () => {
    const { runtime, actions } = makeRuntime();
    const settings = makeInteractiveView("settings", new Set());
    const registered = registerViewScopedActions(runtime, TEST_PLUGIN, [
      settings.view,
    ]);

    expect(registered).toEqual(scopedActionNames(settings.view.scopedActions));
    expect(actions.has("VIEW_SETTINGS_SET_PROVIDER")).toBe(true);
    expect(actions.has("VIEW_SETTINGS_MISSING_TARGET")).toBe(true);

    unregisterViewScopedActions(runtime, TEST_PLUGIN);
    expect(actions.size).toBe(0);
  });

  it("reconciles on reload: a removed scoped action is unregistered", () => {
    const { runtime, actions } = makeRuntime();
    const settings = makeInteractiveView("settings", new Set());
    registerViewScopedActions(runtime, TEST_PLUGIN, [settings.view]);
    expect(actions.size).toBe(2);

    // Reload with only the first action → the second is dropped.
    registerViewScopedActions(runtime, TEST_PLUGIN, [
      { ...settings.view, scopedActions: [settings.view.scopedActions[0]] },
    ]);
    expect(actions.has("VIEW_SETTINGS_SET_PROVIDER")).toBe(true);
    expect(actions.has("VIEW_SETTINGS_MISSING_TARGET")).toBe(false);
  });

  it("keeps the first of a duplicate scoped-action name across views", () => {
    const { runtime, actions } = makeRuntime();
    const warn = vi.fn();
    const a = makeInteractiveView("a", new Set());
    const dupName = a.view.scopedActions[0].name;
    const b = {
      id: "b",
      scopedActions: [
        { ...a.view.scopedActions[0], description: "duplicate name" },
      ],
    };
    const registered = registerViewScopedActions(runtime, TEST_PLUGIN, [
      { id: "a", scopedActions: [a.view.scopedActions[0]] },
      b,
    ]);
    expect(registered).toContain(dupName);
    expect(actions.get(dupName)?.description).toBe(
      a.view.scopedActions[0].description,
    );
    void warn;
  });

  it("does not unregister an incumbent action when a scoped action collides by name", () => {
    const { runtime, actions } = makeRuntime();
    const incumbent: Action = {
      name: "VIEW_SETTINGS_SET_PROVIDER",
      description: "global incumbent",
      handler: async () => undefined,
    };
    runtime.registerAction(incumbent);
    const settings = makeInteractiveView("settings", new Set());

    const registered = registerViewScopedActions(runtime, TEST_PLUGIN, [
      settings.view,
    ]);

    expect(registered).toEqual(["VIEW_SETTINGS_MISSING_TARGET"]);
    expect(actions.get("VIEW_SETTINGS_SET_PROVIDER")).toBe(incumbent);

    unregisterViewScopedActions(runtime, TEST_PLUGIN);
    expect(actions.get("VIEW_SETTINGS_SET_PROVIDER")).toBe(incumbent);
    expect(actions.has("VIEW_SETTINGS_MISSING_TARGET")).toBe(false);
  });
});

/**
 * The Character view's concrete scoped actions (#14155). These exercise the
 * REAL declarations shipped in `BUILTIN_VIEWS` — not a fixture — so the test
 * fails if the declared action names, params, or step targets drift. The
 * mounted stand-in registers exactly the always-mounted `useAgentElement` ids
 * the Character editor renders (bio / add-style-rule / add-conversation), and
 * reports "element not found" for anything else, mirroring the live registry.
 */
const CHARACTER_MOUNTED_IDS = new Set([
  "identity-bio",
  "style-add-input-all",
  "style-add-all",
  "example-add-conversation",
  "post-example-add",
]);
const CHARACTER_TEST_VIEW_ID = "character_fixture";

function characterView() {
  const source = BUILTIN_VIEWS.find((v) => v.id === "character");
  if (!source) throw new Error("character view missing from BUILTIN_VIEWS");
  const filled: Record<string, string> = {};
  const clicked: string[] = [];
  return {
    filled,
    clicked,
    scopedActions: (source.scopedActions ?? []) as ViewScopedAction[],
    view: {
      id: CHARACTER_TEST_VIEW_ID,
      label: "Character view",
      path: `/${CHARACTER_TEST_VIEW_ID}`,
      relatedActions: [] as string[],
      scopedActions: source.scopedActions,
      // Preserve the real view's agent-surface grant so the mutating
      // agent-fill/agent-click steps clear the route/dispatch surface gate.
      surface: source.surface,
      serverInteract: async (
        capability: string,
        params?: Record<string, unknown>,
      ) => {
        const targetId = typeof params?.id === "string" ? params.id : "";
        if (!CHARACTER_MOUNTED_IDS.has(targetId)) {
          return { ok: false, id: targetId, reason: "element not found" };
        }
        if (capability === "agent-fill") {
          filled[targetId] =
            typeof params?.value === "string" ? params.value : "";
          return { ok: true, id: targetId, value: filled[targetId] };
        }
        if (capability === "agent-click") clicked.push(targetId);
        return { ok: true, id: targetId };
      },
    },
  };
}

function findAction(
  scopedActions: ViewScopedAction[],
  name: string,
): ViewScopedAction {
  const decl = scopedActions.find((a) => a.name === name);
  if (!decl) throw new Error(`character view missing scoped action ${name}`);
  return decl;
}

describe("character view scoped actions (#14155)", () => {
  it("declares FILL_BIO / ADD_STYLE_RULE / ADD_MESSAGE_EXAMPLE with stable targets", () => {
    const { scopedActions } = characterView();
    const names = scopedActions.map((a) => a.name);
    expect(names).toEqual([
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ]);

    // Every declared step target must be an always-mounted editor id — guards
    // against declaring against an index-dependent (row-level) id by mistake.
    for (const action of scopedActions) {
      for (const step of action.steps) {
        expect(CHARACTER_MOUNTED_IDS.has(step.target)).toBe(true);
      }
    }

    // FILL_BIO / ADD_STYLE_RULE take their text from a param; ADD_MESSAGE_EXAMPLE
    // is a pure click with no params.
    expect(
      findAction(scopedActions, "VIEW_CHARACTER_FILL_BIO").parameters,
    ).toEqual(["bio"]);
    expect(
      findAction(scopedActions, "VIEW_CHARACTER_ADD_STYLE_RULE").parameters,
    ).toEqual(["rule"]);
    expect(
      findAction(scopedActions, "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE")
        .parameters,
    ).toBeUndefined();
  });

  it("registers exactly the three Character actions and gates them on the view being active", async () => {
    const { runtime, actions } = makeRuntime();
    const char = characterView();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      process.cwd(),
    );
    const registered = registerViewScopedActions(runtime, TEST_PLUGIN, [
      char.view,
    ]);
    expect(registered).toEqual([
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ]);

    const fillBio = actions.get("VIEW_CHARACTER_FILL_BIO");
    expect(fillBio).toBeDefined();

    // Gated closed everywhere but the declaring view.
    await navigateTo("chat");
    expect(await fillBio?.validate?.({} as IAgentRuntime, fakeMessage)).toBe(
      false,
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);
    expect(await fillBio?.validate?.({} as IAgentRuntime, fakeMessage)).toBe(
      true,
    );
  });

  it("FILL_BIO fills the identity-bio control from the {{bio}} param", async () => {
    const char = characterView();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      process.cwd(),
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_FILL_BIO"),
    );
    const result = await action.handler(
      {} as IAgentRuntime,
      fakeMessage,
      undefined,
      { parameters: { bio: "A calm, precise onchain research agent." } },
    );
    expect(result?.success).toBe(true);
    expect(char.filled["identity-bio"]).toBe(
      "A calm, precise onchain research agent.",
    );
    expect(result?.data?.steps).toEqual(["agent-fill:identity-bio"]);
  });

  it("ADD_STYLE_RULE fills the pending input then clicks add", async () => {
    const char = characterView();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      process.cwd(),
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_ADD_STYLE_RULE"),
    );
    const result = await action.handler(
      {} as IAgentRuntime,
      fakeMessage,
      undefined,
      { parameters: { rule: "Keep replies under three sentences." } },
    );
    expect(result?.success).toBe(true);
    expect(char.filled["style-add-input-all"]).toBe(
      "Keep replies under three sentences.",
    );
    expect(char.clicked).toContain("style-add-all");
    expect(result?.data?.steps).toEqual([
      "agent-fill:style-add-input-all",
      "agent-click:style-add-all",
    ]);
  });

  it("ADD_MESSAGE_EXAMPLE clicks add-conversation with no params", async () => {
    const char = characterView();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      process.cwd(),
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE"),
    );
    const result = await action.handler(
      {} as IAgentRuntime,
      fakeMessage,
      undefined,
      {},
    );
    expect(result?.success).toBe(true);
    expect(char.clicked).toContain("example-add-conversation");
    expect(result?.data?.steps).toEqual([
      "agent-click:example-add-conversation",
    ]);
  });

  it("ADD_STYLE_RULE fails loudly if the target id is not mounted", async () => {
    // Register the character view with an EMPTY mounted set: the declared
    // style-add ids are absent, so the first step must throw the typed
    // missing-element error — never a silent no-op.
    const source = BUILTIN_VIEWS.find((v) => v.id === "character");
    const bareView = {
      id: CHARACTER_TEST_VIEW_ID,
      label: "Character view",
      path: `/${CHARACTER_TEST_VIEW_ID}`,
      relatedActions: [] as string[],
      scopedActions: source?.scopedActions,
      // Grant agent-surface (as the real view does) so the step clears the
      // surface gate and reaches the mounted-element check under test.
      surface: source?.surface,
      serverInteract: async (
        _cap: string,
        params?: Record<string, unknown>,
      ) => ({
        ok: false,
        id: typeof params?.id === "string" ? params.id : "",
        reason: "element not found",
      }),
    };
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures (unmounted)",
        views: [bareView],
      },
      process.cwd(),
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      CHARACTER_TEST_VIEW_ID,
      findAction(
        (source?.scopedActions ?? []) as ViewScopedAction[],
        "VIEW_CHARACTER_ADD_STYLE_RULE",
      ),
    );

    let thrown: unknown;
    try {
      await action.handler({} as IAgentRuntime, fakeMessage, undefined, {
        parameters: { rule: "never fills" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(isElizaError(thrown)).toBe(true);
    const elizaErr = thrown as ElizaError;
    expect(elizaErr.code).toBe("VIEW_SCOPED_ACTION_ELEMENT_MISSING");
    expect(elizaErr.context?.target).toBe("style-add-input-all");
  });
});
