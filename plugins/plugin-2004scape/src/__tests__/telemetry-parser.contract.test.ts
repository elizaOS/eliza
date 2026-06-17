// External-API contract test for the 2004scape operator backend.
//
// The injected in-browser bridge (built in src/routes.ts) calls the REAL
// 2004scape client `getBotState()` (BotWorldState, src/sdk/types.ts), runs it
// through trimNpc/trimLoc/trimSkill/trimInventoryItem/trimMessage/trimDialog to
// produce session telemetry, then POSTs it to `.../session/:id/bridge/sync`.
// This test reproduces that normalization over a real-shaped BotWorldState
// fixture, pushes it through the actual `handleAppRoutes` route handlers, and
// asserts buildSessionState / buildSessionTelemetry surface exactly the fields
// the GUI/TUI/detail views read — i.e. the parser maps the upstream API shape
// to a contract-valid session DTO. It also exercises applyOperatorMessage intent
// normalization and applyControlAction pause/resume through the same handlers.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __reset2004scapeBridgeForTests, handleAppRoutes } from "../routes";
import { realBotWorldState } from "./fixtures";

const SESSION_ID = "oakbot42";

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeCtx(
  method: string,
  pathname: string,
  jsonBody?: unknown,
): { ctx: Parameters<typeof handleAppRoutes>[0]; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res = {} as unknown as import("node:http").ServerResponse;
  const req = {} as unknown as import("node:http").IncomingMessage;
  const ctx = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    runtime: null,
    json: (_res: unknown, data: unknown, status = 200) => {
      captured.status = status;
      captured.body = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    readJsonBody: async () => (jsonBody ?? null) as never,
  } as unknown as Parameters<typeof handleAppRoutes>[0];
  return { ctx, captured };
}

// Reproduce the bridge's buildTelemetry() normalization over a real BotWorldState
// (the same trim* shaping done in the injected viewer script in src/routes.ts).
function bridgeBuildTelemetry(state: typeof realBotWorldState) {
  const trimNpc = (npc: (typeof state.nearbyNpcs)[number]) => ({
    index: npc.nid,
    name: npc.name || "Unknown",
    distance: npc.distance,
    x: npc.worldX,
    z: npc.worldZ,
    optionsWithIndex: npc.options
      .slice(0, 3)
      .map((text, i) => ({ text: text || "Option", opIndex: i + 1 })),
  });
  const trimLoc = (loc: (typeof state.nearbyLocs)[number]) => ({
    id: loc.locId,
    name: loc.name || "Unknown",
    distance: loc.distance,
    x: loc.worldX,
    z: loc.worldZ,
    optionsWithIndex: loc.options
      .slice(0, 3)
      .map((text, i) => ({ text: text || "Option", opIndex: i + 1 })),
  });
  const trimSkill = (skill: (typeof state.skills)[number]) => ({
    name: skill.name || "Skill",
    level: skill.level,
    experience: skill.xp,
  });
  const trimInventoryItem = (item: (typeof state.inventory)[number]) => ({
    id: item.id,
    name: item.name || "Item",
    amount: item.count,
  });
  const trimMessage = (m: (typeof state.gameMessages)[number]) => ({
    text: m.text,
    sender: "",
    tick: m.tick,
    type: null,
  });
  const player = state.player;
  return {
    inGame: Boolean(state.inGame),
    tutorial: {
      active: true,
      guideNearby: true,
      visible: false,
      prompt: state.recentDialogs[0]?.text ?? null,
    },
    player: {
      name: player.name,
      combatLevel: player.combatLevel,
      hp: player.hp,
      maxHp: player.maxHp,
      worldX: player.worldX,
      worldZ: player.worldZ,
      animId: player.animId,
    },
    combatStyle: {
      currentStyle: state.combatStyle?.currentStyle ?? 0,
      weaponName: state.combatStyle?.weaponName ?? "",
      activeStyle:
        state.combatStyle?.styles[state.combatStyle.currentStyle]?.name ?? null,
    },
    inventory: state.inventory.map(trimInventoryItem),
    skills: state.skills.map(trimSkill),
    nearbyNpcs: state.nearbyNpcs.map(trimNpc),
    nearbyLocs: state.nearbyLocs.map(trimLoc),
    gameMessages: state.gameMessages.map(trimMessage),
    recentActivity: [
      {
        action: "woodcut",
        detail: "Started chopping Tree.",
        ts: 1_716_000_000_500,
        severity: "info",
      },
    ],
  };
}

beforeEach(() => {
  __reset2004scapeBridgeForTests();
});

afterEach(() => {
  __reset2004scapeBridgeForTests();
});

describe("2004scape operator backend parser contract", () => {
  it("maps a real-shaped BotWorldState through bridge/sync into a session DTO the views read", async () => {
    const telemetry = bridgeBuildTelemetry(realBotWorldState);

    const sync = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/bridge/sync`,
      { cursor: 0, telemetry, viewer: { statusText: "Logged in" } },
    );
    await expect(handleAppRoutes(sync.ctx)).resolves.toBe(true);
    expect(sync.captured.status).toBe(200);
    const syncBody = sync.captured.body as {
      success: boolean;
      session: { status: string };
    };
    expect(syncBody.success).toBe(true);
    // viewerSeenAt fresh + inGame true -> running.
    expect(syncBody.session.status).toBe("running");

    // Now GET the session and assert the parser surfaced the contract fields.
    const get = makeCtx("GET", `/api/apps/2004scape/session/${SESSION_ID}`);
    await expect(handleAppRoutes(get.ctx)).resolves.toBe(true);
    const session = get.captured.body as {
      sessionId: string;
      appName: string;
      canSendCommands: boolean;
      controls: string[];
      goalLabel: string | null;
      suggestedPrompts: string[];
      telemetry: Record<string, unknown>;
    };

    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.appName).toBe("@elizaos/plugin-2004scape");
    expect(session.canSendCommands).toBe(true);
    expect(session.controls).toEqual(["pause", "resume"]);
    // Default seeded goal persists until an operator message overrides it.
    expect(session.goalLabel).toBe(
      "Finish tutorial and start gathering resources.",
    );
    // Tutorial active -> tutorial-flow suggested prompts.
    expect(session.suggestedPrompts).toContain("Finish tutorial");

    const t = session.telemetry;
    // Player coords/HP the GUI + TUI read.
    expect(t.player).toMatchObject({
      name: "oakbot42",
      worldX: 3222,
      worldZ: 3218,
      hp: 9,
      maxHp: 10,
    });
    // Nearby NPC distance + the option text the Nearby Targets list renders.
    expect(t.nearbyNpcs).toEqual([
      expect.objectContaining({
        name: "RuneScape Guide",
        distance: 1.4,
        optionsWithIndex: [{ text: "Talk-to", opIndex: 1 }],
      }),
      expect.objectContaining({
        name: "Fishing spot",
        distance: 4.2,
        optionsWithIndex: [{ text: "Net", opIndex: 1 }],
      }),
    ]);
    // Nearby loc (Tree) the chop target resolves from.
    expect(t.nearbyLocs).toEqual([
      expect.objectContaining({
        name: "Tree",
        distance: 2.0,
        optionsWithIndex: [{ text: "Chop down", opIndex: 1 }],
      }),
    ]);
    // Skills name + level the Field Intel summary renders.
    expect(t.skills).toEqual([
      { name: "Woodcutting", level: 5, experience: 388 },
      { name: "Hitpoints", level: 10, experience: 1154 },
    ]);
    expect(t.inventory).toEqual([
      { id: 1351, name: "Bronze axe", amount: 1 },
      { id: 1511, name: "Logs", amount: 3 },
    ]);
    expect(t.combatStyle).toMatchObject({
      weaponName: "Bronze axe",
      activeStyle: "Accurate",
    });
    // Backend-injected fields.
    expect(t.botName).toBe(SESSION_ID);
    expect(t.autoPlay).toBe(true);
    expect(t.intent).toBe("tutorial");
    // recentActivity preserved + surfaced for the Recent Activity list.
    expect(Array.isArray(t.recentActivity)).toBe(true);
    expect(t.recentActivity).toContainEqual(
      expect.objectContaining({
        action: "woodcut",
        detail: "Started chopping Tree.",
      }),
    );
  });

  it("applyOperatorMessage normalizes intent (woodcutting) and updates the goal", async () => {
    // Seed the session first.
    const seed = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/bridge/sync`,
      { cursor: 0, telemetry: bridgeBuildTelemetry(realBotWorldState) },
    );
    await handleAppRoutes(seed.ctx);

    const msg = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/message`,
      { content: "go chop some trees for logs" },
    );
    await expect(handleAppRoutes(msg.ctx)).resolves.toBe(true);
    expect(msg.captured.status).toBe(202);
    const body = msg.captured.body as {
      success: boolean;
      session: { goalLabel: string | null; telemetry: { intent: string } };
    };
    expect(body.success).toBe(true);
    // Free-text goal overrides the computed tutorial goal.
    expect(body.session.goalLabel).toBe("go chop some trees for logs");
    // "chop / trees / logs" -> woodcutting intent.
    expect(body.session.telemetry.intent).toBe("woodcutting");
  });

  it("normalizes fishing and bank intents", async () => {
    for (const [content, intent] of [
      ["net some shrimp", "fishing"],
      ["head to the bank", "bank"],
    ] as const) {
      __reset2004scapeBridgeForTests();
      await handleAppRoutes(
        makeCtx(
          "POST",
          `/api/apps/2004scape/session/${SESSION_ID}/bridge/sync`,
          { cursor: 0, telemetry: { inGame: true } },
        ).ctx,
      );
      const msg = makeCtx(
        "POST",
        `/api/apps/2004scape/session/${SESSION_ID}/message`,
        { content },
      );
      await handleAppRoutes(msg.ctx);
      const body = msg.captured.body as {
        session: { telemetry: { intent: string } };
      };
      expect(body.session.telemetry.intent).toBe(intent);
    }
  });

  it("applyControlAction pause then resume mutates buildSessionState", async () => {
    await handleAppRoutes(
      makeCtx("POST", `/api/apps/2004scape/session/${SESSION_ID}/bridge/sync`, {
        cursor: 0,
        telemetry: { inGame: true },
      }).ctx,
    );

    const pause = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/control`,
      { action: "pause" },
    );
    await expect(handleAppRoutes(pause.ctx)).resolves.toBe(true);
    const paused = pause.captured.body as {
      success: boolean;
      session: { status: string; telemetry: { autoPlay: boolean } };
    };
    expect(paused.success).toBe(true);
    expect(paused.session.status).toBe("paused");
    expect(paused.session.telemetry.autoPlay).toBe(false);

    const resume = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/control`,
      { action: "resume" },
    );
    await handleAppRoutes(resume.ctx);
    const resumed = resume.captured.body as {
      session: { status: string; telemetry: { autoPlay: boolean } };
    };
    // Fresh viewer + inGame -> running again after resume.
    expect(resumed.session.status).toBe("running");
    expect(resumed.session.telemetry.autoPlay).toBe(true);
  });

  it("rejects empty operator messages and invalid control actions", async () => {
    await handleAppRoutes(
      makeCtx("POST", `/api/apps/2004scape/session/${SESSION_ID}/bridge/sync`, {
        cursor: 0,
        telemetry: { inGame: true },
      }).ctx,
    );

    const emptyMsg = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/message`,
      { content: "   " },
    );
    await handleAppRoutes(emptyMsg.ctx);
    expect(emptyMsg.captured.status).toBe(400);

    const badControl = makeCtx(
      "POST",
      `/api/apps/2004scape/session/${SESSION_ID}/control`,
      { action: "explode" },
    );
    await handleAppRoutes(badControl.ctx);
    expect(badControl.captured.status).toBe(400);
  });
});
