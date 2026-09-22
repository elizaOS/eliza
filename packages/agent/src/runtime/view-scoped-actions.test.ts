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
import type {
  Action,
  IAgentRuntime,
  Memory,
  ViewScopedAction,
} from "@elizaos/core";
import {
  AgentRuntime,
  createCharacter,
  type ElizaError,
  isElizaError,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../core/src/actions/validate-tool-args.ts";
import { claimRendererReply } from "../__tests__/view-renderer-test-utils.ts";
import { BUILTIN_VIEWS } from "../api/builtin-views.ts";
import {
  beginViewInstallation,
  closeRuntimeViewRegistry,
  commitViewInstallation,
} from "../api/view-installations.ts";
import { closeViewInteractionHost } from "../api/view-interaction-host.ts";
import { getView, registerPluginViews } from "../api/views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  resolveViewInteractResult,
  setViewsBroadcastWs,
  type ViewsRouteContext,
} from "../api/views-routes.ts";
import { clearActiveViewContext } from "./view-action-affinity.ts";
import { runWithViewClient } from "./view-client-context.ts";
import {
  buildViewScopedAction,
  registerViewScopedActions,
  scopedActionNames,
  unregisterViewScopedActions,
} from "./view-scoped-actions.ts";

let runtime: AgentRuntime;
let hostKey: object;
let scope: { hostKey: object; clientId: string };
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
  const interactionRuntimes: Array<IAgentRuntime | undefined> = [];
  return {
    filled,
    clicked,
    interactionRuntimes,
    view: {
      id,
      label: `${id} view`,
      path: `/${id}`,
      surface: { capabilities: ["agent-surface"] as const },
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
        context?: { runtime?: IAgentRuntime },
      ) => {
        interactionRuntimes.push(context?.runtime);
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
async function navigateTo(
  id: string,
  viewType: "gui" | "tui" = "gui",
): Promise<void> {
  const req = Readable.from([
    Buffer.from(JSON.stringify({ source: "user" })),
  ]) as unknown as http.IncomingMessage;
  req.headers = {
    "content-type": "application/json",
    "x-elizaos-client-id": scope.clientId,
  };
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  const ctx: ViewsRouteContext = {
    runtime,
    hostKey,
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}?viewType=${viewType}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
  };
  await handleViewsRoutes(ctx);
  expect(ctx.error).not.toHaveBeenCalled();
}

/** Report the mounted shell owner through the real elements route. */
async function reportMountedClient(
  id: string,
  clientId: string,
): Promise<void> {
  const body = {
    clientId,
    viewType: "gui",
    installationId: getView(runtime, id)?.installationId,
    elements: [{ id: "provider-select", role: "select", label: "Provider" }],
  };
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as unknown as http.IncomingMessage;
  req.headers = {
    "content-type": "application/json",
    "x-elizaos-client-id": scope.clientId,
  };
  const pathname = `/api/views/${encodeURIComponent(id)}/elements`;
  const ctx: ViewsRouteContext = {
    runtime,
    hostKey,
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
  };
  await handleViewsRoutes(ctx);
}

function registerScopedFixture(
  ownerRuntime: AgentRuntime,
  owner: string,
  views: Parameters<typeof registerViewScopedActions>[2],
) {
  const installation = beginViewInstallation(ownerRuntime, owner);
  commitViewInstallation(
    ownerRuntime,
    installation,
    views.map((view) => ({
      label: view.id,
      ...view,
      pluginName: owner,
      viewType: "gui",
      hasHeroImage: false,
      available: true,
      loadedAt: 0,
      platform: "web",
    })),
  );
  return registerViewScopedActions(ownerRuntime, owner, views);
}

const fakeMessage = { content: {} } as Memory;

beforeEach(async () => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "Scoped actions" }),
    enableAutonomy: false,
  });
  hostKey = {};
  scope = { hostKey, clientId: "mounted-settings-shell" };
  await registerPluginViews(runtime, {
    name: "chat-fixture",
    description: "Other active page",
    views: [{ id: "chat", label: "Chat", path: "/chat" }],
  });
  clearCurrentViewState(runtime, scope);
  clearActiveViewContext(runtime, scope);
  // Give the module a broadcaster so the "no shell to reach" guard never fires
  // in this test — the mounted serverInteract is what actually resolves steps.
  setViewsBroadcastWs(hostKey, () => {});
});

afterEach(() => {
  closeRuntimeViewRegistry(runtime);
  closeViewInteractionHost(hostKey);
  clearCurrentViewState(runtime, scope);
  clearActiveViewContext(runtime, scope);
  setViewsBroadcastWs(hostKey, null);
  vi.restoreAllMocks();
});

describe("view-scoped action validate() gating on the active view", () => {
  it("returns false when the declaring view is not active and true when it is", async () => {
    const settings = makeInteractiveView(INTERACTIVE_VIEW_ID, new Set());
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      { pluginDir: process.cwd() },
    );
    const action = buildViewScopedAction(
      runtime,
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );

    // No active view → gated closed.
    expect(
      await runWithViewClient(scope, () =>
        action.validate(runtime, fakeMessage),
      ),
    ).toBe(false);

    // Switch to a DIFFERENT view → still closed.
    await navigateTo("chat");
    expect(
      await runWithViewClient(scope, () =>
        action.validate(runtime, fakeMessage),
      ),
    ).toBe(false);

    // Switch INTO the declaring view via the real navigate route → open.
    await navigateTo(INTERACTIVE_VIEW_ID);
    expect(
      await runWithViewClient(scope, () =>
        action.validate(runtime, fakeMessage),
      ),
    ).toBe(true);

    // Switch away again → closes without any restart.
    await navigateTo("chat");
    expect(
      await runWithViewClient(scope, () =>
        action.validate(runtime, fakeMessage),
      ),
    ).toBe(false);
  });
});

describe("view-scoped action handler drives the interact protocol", () => {
  it.each([undefined, "requesting-shell"])(
    "keeps scoped actions on their owning client (%s)",
    async (requestingClient) => {
      const settings = makeInteractiveView(
        INTERACTIVE_VIEW_ID,
        new Set(["provider-select", "save-button"]),
      );
      await registerPluginViews(
        runtime,
        {
          name: TEST_PLUGIN,
          description: "scoped action fixtures",
          views: [settings.view],
        },
        { pluginDir: process.cwd() },
      );
      await navigateTo(INTERACTIVE_VIEW_ID);
      await reportMountedClient(INTERACTIVE_VIEW_ID, "mounted-settings-shell");

      const targetedFrames: Array<Record<string, unknown>> = [];
      setViewsBroadcastWs(hostKey, vi.fn(), (clientId, payload) => {
        expect(clientId).toBe(requestingClient ?? "mounted-settings-shell");
        const frame = payload as Record<string, unknown>;
        targetedFrames.push(frame);
        resolveViewInteractResult(runtime, hostKey, clientId, {
          ...claimRendererReply(runtime, hostKey, clientId, frame),
          success: true,
          result: {
            ok: true,
            id: (frame.params as Record<string, unknown> | undefined)?.id,
          },
        });
        return 1;
      });

      const action = buildViewScopedAction(
        runtime,
        INTERACTIVE_VIEW_ID,
        settings.view.scopedActions[0],
      );
      const pending = runWithViewClient(scope, () =>
        action.handler(
          runtime,
          {
            ...fakeMessage,
            content: {
              ...fakeMessage.content,
              metadata: requestingClient
                ? { viewClientId: requestingClient }
                : undefined,
            },
          },
          undefined,
          { parameters: { provider: "anthropic" } },
        ),
      );

      if (requestingClient) {
        await expect(pending).rejects.toMatchObject({
          code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE",
        });
        expect(targetedFrames).toEqual([]);
        return;
      }
      const result = await pending;
      expect(result?.success).toBe(true);
      expect(targetedFrames).toHaveLength(3);
      expect(targetedFrames.map((frame) => frame.capability)).toEqual([
        "agent-focus",
        "agent-fill",
        "agent-click",
      ]);
      expect(settings.interactionRuntimes).toEqual([]);
    },
  );

  it("resolves a named action to the real agent-fill/click sequence", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select", "save-button"]),
    );
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    const result = await runWithViewClient(scope, () =>
      action.handler(runtime, fakeMessage, undefined, {
        parameters: { provider: "anthropic" },
      }),
    );

    expect(result?.success).toBe(true);
    // The fill drove the real serverInteract with the resolved param value…
    expect(settings.filled["provider-select"]).toBe("anthropic");
    // …and the click step ran.
    expect(settings.clicked).toContain("save-button");
    expect(settings.interactionRuntimes).toEqual([runtime, runtime, runtime]);
    // The step trace is reported for observability.
    expect(result?.data?.steps).toEqual([
      "agent-focus:provider-select",
      "agent-fill:provider-select",
      "agent-click:save-button",
    ]);
  });

  it("selects a parameterized mounted day and rejects missing target parameters", async () => {
    const calendar = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["calendar-day-2026-09-06"]),
    );
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "calendar target",
        views: [calendar.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(INTERACTIVE_VIEW_ID);
    const action = buildViewScopedAction(runtime, INTERACTIVE_VIEW_ID, {
      name: "SELECT_DAY",
      description: "Select the displayed day",
      parameters: ["date"],
      steps: [{ kind: "agent-click", target: "calendar-day-{{date}}" }],
    });
    await expect(
      runWithViewClient(scope, () =>
        action.handler(runtime, fakeMessage, undefined, { parameters: {} }),
      ),
    ).rejects.toMatchObject({ code: "VIEW_SCOPED_ACTION_PARAM_MISSING" });
    expect(calendar.clicked).toEqual([]);
    const result = await runWithViewClient(scope, () =>
      action.handler(runtime, fakeMessage, undefined, {
        parameters: validateToolArgs(action, { date: "2026-09-06" }).args as {
          date: string;
        },
      }),
    );
    expect(result?.success).toBe(true);
    expect(calendar.clicked).toEqual(["calendar-day-2026-09-06"]);
  });

  it("throws a typed missing-element error when a target useAgentElement id is not mounted", async () => {
    const settings = makeInteractiveView(
      INTERACTIVE_VIEW_ID,
      new Set(["provider-select"]),
    );
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    // The MISSING_TARGET action clicks "ghost-button", which is never mounted.
    const action = buildViewScopedAction(
      runtime,
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[1],
    );

    let thrown: unknown;
    try {
      await runWithViewClient(scope, () =>
        action.handler(runtime, fakeMessage, undefined, {}),
      );
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
      runtime,
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(INTERACTIVE_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    // No `provider` param → the {{provider}} fill step must fail loudly, not
    // fill an empty string into the real control.
    await expect(
      runWithViewClient(scope, () =>
        action.handler(runtime, fakeMessage, undefined, {
          parameters: {},
        }),
      ),
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
      runtime,
      {
        name: TEST_PLUGIN,
        description: "scoped action fixtures",
        views: [settings.view],
      },
      { pluginDir: process.cwd() },
    );
    // Navigate to a different view so the handler's defense-in-depth gate fires
    // even though the executor would normally block on validate().
    await navigateTo("chat");

    const action = buildViewScopedAction(
      runtime,
      INTERACTIVE_VIEW_ID,
      settings.view.scopedActions[0],
    );
    await expect(
      runWithViewClient(scope, () =>
        action.handler(runtime, fakeMessage, undefined, {
          parameters: { provider: "anthropic" },
        }),
      ),
    ).rejects.toMatchObject({ code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE" });
  });
});

describe("view-scoped action registration reconciliation", () => {
  it("registers a view's scoped actions and unregisters exactly its set", () => {
    const settings = makeInteractiveView("settings", new Set());
    const registered = registerScopedFixture(runtime, TEST_PLUGIN, [
      settings.view,
    ]);

    expect(registered).toEqual(scopedActionNames(settings.view.scopedActions));
    expect(
      runtime.actions.some(
        (action) => action.name === "VIEW_SETTINGS_SET_PROVIDER",
      ),
    ).toBe(true);
    expect(
      runtime.actions.some(
        (action) => action.name === "VIEW_SETTINGS_MISSING_TARGET",
      ),
    ).toBe(true);

    unregisterViewScopedActions(runtime, TEST_PLUGIN);
    expect(runtime.actions.length).toBe(0);
  });

  it("reconciles on reload: a removed scoped action is unregistered", () => {
    const settings = makeInteractiveView("settings", new Set());
    registerScopedFixture(runtime, TEST_PLUGIN, [settings.view]);
    expect(runtime.actions.length).toBe(2);

    // Reload with only the first action → the second is dropped.
    registerScopedFixture(runtime, TEST_PLUGIN, [
      { ...settings.view, scopedActions: [settings.view.scopedActions[0]] },
    ]);
    expect(
      runtime.actions.some(
        (action) => action.name === "VIEW_SETTINGS_SET_PROVIDER",
      ),
    ).toBe(true);
    expect(
      runtime.actions.some(
        (action) => action.name === "VIEW_SETTINGS_MISSING_TARGET",
      ),
    ).toBe(false);
  });

  it("keeps the first of a duplicate scoped-action name across views", () => {
    const warn = vi.fn();
    const a = makeInteractiveView("a", new Set());
    const dupName = a.view.scopedActions[0].name;
    const b = {
      id: "b",
      scopedActions: [
        { ...a.view.scopedActions[0], description: "duplicate name" },
      ],
    };
    const registered = registerScopedFixture(runtime, TEST_PLUGIN, [
      { id: "a", scopedActions: [a.view.scopedActions[0]] },
      b,
    ]);
    expect(registered).toContain(dupName);
    expect(
      runtime.actions.find((action) => action.name === dupName)?.description,
    ).toBe(a.view.scopedActions[0].description);
    void warn;
  });

  it("does not unregister an incumbent action when a scoped action collides by name", () => {
    const incumbent: Action = {
      name: "VIEW_SETTINGS_SET_PROVIDER",
      description: "global incumbent",
      validate: async () => true,
      handler: async () => ({ success: true }),
    };
    runtime.registerAction(incumbent);
    const settings = makeInteractiveView("settings", new Set());

    const registered = registerScopedFixture(runtime, TEST_PLUGIN, [
      settings.view,
    ]);

    expect(registered).toEqual(["VIEW_SETTINGS_MISSING_TARGET"]);
    expect(
      runtime.actions.find(
        (action) => action.name === "VIEW_SETTINGS_SET_PROVIDER",
      ),
    ).toBe(incumbent);

    unregisterViewScopedActions(runtime, TEST_PLUGIN);
    expect(
      runtime.actions.find(
        (action) => action.name === "VIEW_SETTINGS_SET_PROVIDER",
      ),
    ).toBe(incumbent);
    expect(
      runtime.actions.some(
        (action) => action.name === "VIEW_SETTINGS_MISSING_TARGET",
      ),
    ).toBe(false);
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
    const char = characterView();
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      { pluginDir: process.cwd() },
    );
    const registered = registerScopedFixture(runtime, TEST_PLUGIN, [char.view]);
    expect(registered).toEqual([
      "VIEW_CHARACTER_FILL_BIO",
      "VIEW_CHARACTER_ADD_STYLE_RULE",
      "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE",
    ]);

    const fillBio = runtime.actions.find(
      (action) => action.name === "VIEW_CHARACTER_FILL_BIO",
    );
    expect(fillBio).toBeDefined();

    // Gated closed everywhere but the declaring view.
    await navigateTo("chat");
    expect(
      await runWithViewClient(scope, () =>
        fillBio?.validate?.(runtime, fakeMessage),
      ),
    ).toBe(false);
    await navigateTo(CHARACTER_TEST_VIEW_ID);
    expect(
      await runWithViewClient(scope, () =>
        fillBio?.validate?.(runtime, fakeMessage),
      ),
    ).toBe(true);
  });

  it("FILL_BIO fills the identity-bio control from the {{bio}} param", async () => {
    const char = characterView();
    await registerPluginViews(
      runtime,
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_FILL_BIO"),
    );
    const result = await runWithViewClient(scope, () =>
      action.handler(runtime, fakeMessage, undefined, {
        parameters: { bio: "A calm, precise onchain research agent." },
      }),
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
      runtime,
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_ADD_STYLE_RULE"),
    );
    const result = await runWithViewClient(scope, () =>
      action.handler(runtime, fakeMessage, undefined, {
        parameters: { rule: "Keep replies under three sentences." },
      }),
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
      runtime,
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures",
        views: [char.view],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      CHARACTER_TEST_VIEW_ID,
      findAction(char.scopedActions, "VIEW_CHARACTER_ADD_MESSAGE_EXAMPLE"),
    );
    const result = await runWithViewClient(scope, () =>
      action.handler(runtime, fakeMessage, undefined, {}),
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
      runtime,
      {
        name: TEST_PLUGIN,
        description: "character scoped action fixtures (unmounted)",
        views: [bareView],
      },
      { pluginDir: process.cwd() },
    );
    await navigateTo(CHARACTER_TEST_VIEW_ID);

    const action = buildViewScopedAction(
      runtime,
      CHARACTER_TEST_VIEW_ID,
      findAction(
        (source?.scopedActions ?? []) as ViewScopedAction[],
        "VIEW_CHARACTER_ADD_STYLE_RULE",
      ),
    );

    let thrown: unknown;
    try {
      await runWithViewClient(scope, () =>
        action.handler(runtime, fakeMessage, undefined, {
          parameters: { rule: "never fills" },
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(isElizaError(thrown)).toBe(true);
    const elizaErr = thrown as ElizaError;
    expect(elizaErr.code).toBe("VIEW_SCOPED_ACTION_ELEMENT_MISSING");
    expect(elizaErr.context?.target).toBe("style-add-input-all");
  });
});

it("binds scoped action effects to the declared modality, not the GUI fallback", async () => {
  const effects: string[] = [];
  const scoped = {
    name: "TUI_ONLY_CLICK",
    description: "TUI control",
    steps: [{ kind: "agent-click" as const, target: "save" }],
  };
  const views = (["gui", "tui"] as const).map((viewType) => ({
    id: "modality-owner",
    label: viewType,
    path: "/modality",
    viewType,
    surface: { capabilities: ["agent-surface"] as const },
    scopedActions: viewType === "tui" ? [scoped] : [],
    serverInteract: async () => {
      effects.push(viewType);
      return { ok: true };
    },
  }));
  await registerPluginViews(runtime, {
    name: TEST_PLUGIN,
    description: "Modality authority",
    views,
  });
  registerViewScopedActions(runtime, TEST_PLUGIN, views);
  const action = runtime.actions.find((action) => action.name === scoped.name);
  if (!action) throw new Error("TUI scoped action missing");
  await navigateTo("modality-owner", "tui");
  await runWithViewClient(scope, () => action.handler(runtime, fakeMessage));
  expect(effects).toEqual(["tui"]);
  await navigateTo("modality-owner", "gui");
  expect(
    await runWithViewClient(scope, () => action.validate(runtime, fakeMessage)),
  ).toBe(false);
  await expect(
    runWithViewClient(scope, () => action.handler(runtime, fakeMessage)),
  ).rejects.toMatchObject({ code: "VIEW_SCOPED_ACTION_VIEW_INACTIVE" });
  expect(effects).toEqual(["tui"]);
});
