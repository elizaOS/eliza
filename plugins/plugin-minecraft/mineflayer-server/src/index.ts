import mineflayer, { type Bot } from "mineflayer";
import { pathfinder, Movements, goals } from "mineflayer-pathfinder";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | { [key: string]: JsonValue }
  | JsonValue[];

type JsonObject = { [key: string]: JsonValue };

interface BridgeRequest {
  type: string;
  requestId: string;
  botId?: string;
  data?: JsonObject;
}

interface BridgeResponse {
  type: string;
  requestId: string;
  success: boolean;
  data?: JsonObject;
  error?: string;
}

function requireNumber(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const requestSchema = z.object({
  type: z.string(),
  requestId: z.string(),
  botId: z.string().optional(),
  data: z.record(z.string(), jsonValueSchema).optional(),
});

const port = requireNumber(process.env.MC_SERVER_PORT, 3457);

type BotEntry = {
  bot: Bot;
  createdAtMs: number;
};

const bots = new Map<string, BotEntry>();

const allowedControls = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;
type AllowedControl = (typeof allowedControls)[number];

const allowedEquipDestinations = ["hand", "off-hand", "head", "torso", "legs", "feet"] as const;
type AllowedEquipDestination = (typeof allowedEquipDestinations)[number];

function send(ws: WebSocket, response: BridgeResponse): void {
  ws.send(JSON.stringify(response));
}

function ok(request: BridgeRequest, data?: JsonObject): BridgeResponse {
  return { type: request.type, requestId: request.requestId, success: true, data };
}

function fail(request: BridgeRequest, error: string): BridgeResponse {
  return { type: request.type, requestId: request.requestId, success: false, error };
}

function getBot(botId: string | undefined): BotEntry | undefined {
  if (!botId) return undefined;
  return bots.get(botId);
}

function vecFromData(data: JsonObject): Vec3 | null {
  const x = data.x;
  const y = data.y;
  const zVal = data.z;
  if (typeof x !== "number" || typeof y !== "number" || typeof zVal !== "number") {
    return null;
  }
  return new Vec3(x, y, zVal);
}

function directionToVec(face: string): Vec3 | null {
  switch (face) {
    case "up":
      return new Vec3(0, 1, 0);
    case "down":
      return new Vec3(0, -1, 0);
    case "north":
      return new Vec3(0, 0, -1);
    case "south":
      return new Vec3(0, 0, 1);
    case "west":
      return new Vec3(-1, 0, 0);
    case "east":
      return new Vec3(1, 0, 0);
    default:
      return null;
  }
}

function serializeBotState(bot: Bot): JsonObject {
  const pos = bot.entity?.position;
  const floored = pos ? new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) : null;
  const mcData = minecraftData(bot.version);

  // Best-effort biome detection from the block at the bot's feet.
  const feetBlock = floored ? bot.blockAt(floored) : null;
  const biomeObj =
    feetBlock && (feetBlock as { biome?: { id?: number; name?: string } }).biome
      ? (feetBlock as { biome?: { id?: number; name?: string } }).biome
      : null;
  const biomeId = biomeObj && typeof biomeObj.id === "number" ? biomeObj.id : null;
  const biomeNameFromBlock = biomeObj && typeof biomeObj.name === "string" ? biomeObj.name : null;
  const biomeNameFromData =
    biomeId !== null && mcData.biomes && mcData.biomes[biomeId] && typeof mcData.biomes[biomeId].name === "string"
      ? mcData.biomes[biomeId].name
      : null;
  const biomeName = biomeNameFromBlock ?? biomeNameFromData;

  // "Vision": what the bot is currently looking at (best-effort).
  let lookingAt: JsonObject | null = null;
  try {
    const cursorBlock = bot.blockAtCursor(6);
    if (cursorBlock) {
      const cp = cursorBlock.position;
      const dist = pos ? cursorBlock.position.distanceTo(pos) : null;
      lookingAt = {
        kind: "block",
        name: cursorBlock.name,
        position: { x: cp.x, y: cp.y, z: cp.z },
        distance: typeof dist === "number" ? dist : null,
      };
    }
  } catch {
    lookingAt = null;
  }

  const entities = Object.values(bot.entities ?? {});
  const nearby = pos
    ? entities
        .filter((e) => e?.position && e.position.distanceTo(pos) <= 24)
        .slice(0, 50)
        .map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name ?? null,
          username: e.username ?? null,
          kind: e.kind ?? null,
          position: { x: e.position.x, y: e.position.y, z: e.position.z },
        }))
    : [];

  const items = bot.inventory?.items?.() ?? [];
  const inv = items.slice(0, 60).map((it) => ({
    name: it.name,
    displayName: it.displayName,
    count: it.count,
    slot: it.slot,
  }));

  return {
    connected: true,
    username: bot.username ?? null,
    version: bot.version ?? null,
    health: typeof bot.health === "number" ? bot.health : null,
    food: typeof bot.food === "number" ? bot.food : null,
    experience: typeof bot.experience?.level === "number" ? bot.experience.level : null,
    position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    yaw: typeof bot.entity?.yaw === "number" ? bot.entity.yaw : null,
    pitch: typeof bot.entity?.pitch === "number" ? bot.entity.pitch : null,
    time: typeof bot.time?.timeOfDay === "number" ? bot.time.timeOfDay : null,
    biome: biomeId !== null || biomeName !== null ? { id: biomeId, name: biomeName } : null,
    lookingAt,
    inventory: inv,
    nearbyEntities: nearby,
  };
}

const wss = new WebSocketServer({ port });

wss.on("listening", () => {
  // Process managers look for a "listening on port" substring.
  // Keep this stable.
  // eslint-disable-next-line no-console
  console.log(`listening on port ${port}`);
});

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let request: BridgeRequest;
    try {
      const parsed = JSON.parse(text) as JsonValue;
      request = requestSchema.parse(parsed) as BridgeRequest;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid request";
      ws.send(
        JSON.stringify({
          type: "error",
          requestId: "parse-error",
          success: false,
          error: message,
        } satisfies BridgeResponse),
      );
      return;
    }

    try {
      if (request.type === "health") {
        send(ws, ok(request, { status: "ok" }));
        return;
      }

      if (request.type === "createBot") {
        const data = request.data ?? {};
        const host = typeof data.host === "string" ? data.host : process.env.MC_HOST ?? "127.0.0.1";
        const serverPort =
          typeof data.port === "number"
            ? data.port
            : requireNumber(process.env.MC_PORT, 25565);
        const username =
          typeof data.username === "string"
            ? data.username
            : process.env.MC_USERNAME ?? "ElizaBot";
        const auth = typeof data.auth === "string" ? data.auth : process.env.MC_AUTH ?? "offline";
        // Mineflayer can auto-detect version when it connects, but if the connection fails
        // very early (e.g. closed port) some downstream code can crash when version is undefined.
        // Use a safe default to keep error handling reliable.
        const version =
          typeof data.version === "string"
            ? data.version
            : process.env.MC_VERSION ?? "1.20.4";

        const botId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        let bot: Bot;
        try {
          bot = mineflayer.createBot({
            host,
            port: serverPort,
            username,
            auth: auth === "microsoft" ? "microsoft" : "offline",
            version,
          });
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          const normalized = raw.includes("blocksByName")
            ? `Failed to connect to Minecraft server at ${host}:${serverPort} (is it running?)`
            : raw;
          send(ws, fail(request, normalized));
          return;
        }

        bots.set(botId, { bot, createdAtMs: Date.now() });

        bot.once("spawn", () => {
          // Load pathfinder only after spawn (bot.version is known).
          try {
            bot.loadPlugin(pathfinder);
            const defaultMovements = new Movements(bot);
            bot.pathfinder.setMovements(defaultMovements);
          } catch {
            // Non-fatal: bot can still operate without pathfinder.
          }
          send(ws, ok(request, { botId }));
        });

        bot.once("error", (e) => {
          bots.delete(botId);
          const raw = e instanceof Error ? e.message : String(e);
          // Mineflayer can emit confusing internal errors when the TCP connection fails very early.
          // Normalize these to a helpful message for clients.
          const normalized = raw.includes("blocksByName")
            ? `Failed to connect to Minecraft server at ${host}:${serverPort} (is it running?)`
            : raw;
          send(ws, fail(request, normalized));
        });

        bot.once("end", () => {
          bots.delete(botId);
        });

        return;
      }

      const entry = getBot(request.botId);
      if (!entry) {
        send(ws, fail(request, "No such botId (createBot first)"));
        return;
      }

      const { bot } = entry;
      const data = request.data ?? {};

      switch (request.type) {
        case "destroyBot": {
          bots.delete(request.botId ?? "");
          bot.quit("destroyBot");
          send(ws, ok(request, { destroyed: true }));
          return;
        }
        case "chat": {
          const message = typeof data.message === "string" ? data.message : null;
          if (!message) {
            send(ws, fail(request, "Missing data.message"));
            return;
          }
          bot.chat(message);
          send(ws, ok(request, { sent: true }));
          return;
        }
        case "control": {
          const control = typeof data.control === "string" ? data.control : null;
          const state = typeof data.state === "boolean" ? data.state : null;
          const durationMs = typeof data.durationMs === "number" ? data.durationMs : null;
          if (!control || state === null) {
            send(ws, fail(request, "Missing data.control or data.state"));
            return;
          }
          if (!allowedControls.includes(control as AllowedControl)) {
            send(ws, fail(request, `Invalid control: ${control}`));
            return;
          }
          bot.setControlState(control as AllowedControl, state);
          if (durationMs && durationMs > 0) {
            setTimeout(() => {
              bot.setControlState(control as AllowedControl, false);
            }, durationMs);
          }
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "look": {
          const yaw = typeof data.yaw === "number" ? data.yaw : null;
          const pitch = typeof data.pitch === "number" ? data.pitch : null;
          if (yaw === null || pitch === null) {
            send(ws, fail(request, "Missing data.yaw or data.pitch"));
            return;
          }
          await bot.look(yaw, pitch);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "goto": {
          if (!bot.pathfinder) {
            send(ws, fail(request, "Pathfinder not ready (bot not spawned yet)"));
            return;
          }
          const vec = vecFromData(data);
          if (!vec) {
            send(ws, fail(request, "Missing numeric data.x/data.y/data.z"));
            return;
          }
          const range = typeof data.range === "number" ? data.range : 0;
          const goal = range > 0 ? new goals.GoalNear(vec.x, vec.y, vec.z, range) : new goals.GoalBlock(vec.x, vec.y, vec.z);
          await bot.pathfinder.goto(goal);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "stop": {
          if (!bot.pathfinder) {
            send(ws, ok(request, { ok: true }));
            return;
          }
          bot.pathfinder.setGoal(null);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "dig": {
          const vec = vecFromData(data);
          if (!vec) {
            send(ws, fail(request, "Missing numeric data.x/data.y/data.z"));
            return;
          }
          const block = bot.blockAt(vec);
          if (!block) {
            send(ws, fail(request, "No block at given coordinates"));
            return;
          }
          await bot.dig(block);
          send(ws, ok(request, { ok: true, blockName: block.name }));
          return;
        }
        case "place": {
          const vec = vecFromData(data);
          const face = typeof data.face === "string" ? data.face : null;
          if (!vec || !face) {
            send(ws, fail(request, "Missing numeric data.x/data.y/data.z or data.face"));
            return;
          }
          const dir = directionToVec(face);
          if (!dir) {
            send(ws, fail(request, "Invalid face (use up/down/north/south/east/west)"));
            return;
          }
          const reference = bot.blockAt(vec);
          if (!reference) {
            send(ws, fail(request, "No reference block at coordinates"));
            return;
          }
          await bot.placeBlock(reference, dir);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "equip": {
          const itemName = typeof data.itemName === "string" ? data.itemName : null;
          const destination = typeof data.destination === "string" ? data.destination : "hand";
          if (!itemName) {
            send(ws, fail(request, "Missing data.itemName"));
            return;
          }
          const item = bot.inventory.items().find((it) => it.name === itemName);
          if (!item) {
            send(ws, fail(request, `Item not found in inventory: ${itemName}`));
            return;
          }
          if (!allowedEquipDestinations.includes(destination as AllowedEquipDestination)) {
            send(ws, fail(request, `Invalid destination: ${destination}`));
            return;
          }
          await bot.equip(item, destination as AllowedEquipDestination);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "useItem": {
          bot.activateItem();
          setTimeout(() => bot.deactivateItem(), 250);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "attack": {
          const target = typeof data.entityId === "number" ? data.entityId : null;
          if (target === null) {
            send(ws, fail(request, "Missing data.entityId"));
            return;
          }
          const entity = bot.entities[target];
          if (!entity) {
            send(ws, fail(request, "Entity not found"));
            return;
          }
          bot.attack(entity);
          send(ws, ok(request, { ok: true }));
          return;
        }
        case "getState": {
          send(ws, ok(request, serializeBotState(bot)));
          return;
        }
        case "getInventory": {
          const items = bot.inventory.items().map((it) => ({
            name: it.name,
            displayName: it.displayName,
            count: it.count,
            slot: it.slot,
          }));
          send(ws, ok(request, { items }));
          return;
        }
        case "scan": {
          const radius = typeof data.radius === "number" ? data.radius : 16;
          const max = typeof data.maxResults === "number" ? data.maxResults : 64;
          const blockNames = Array.isArray(data.blocks) ? data.blocks.filter((b) => typeof b === "string") : [];

          const mcData = minecraftData(bot.version);
          const ids = blockNames
            .map((name) => mcData.blocksByName[name]?.id)
            .filter((id): id is number => typeof id === "number");

          const positions =
            ids.length > 0
              ? bot.findBlocks({ matching: ids, maxDistance: radius, count: max })
              : bot.findBlocks({ matching: (b) => b.type !== 0, maxDistance: radius, count: max });

          const found = positions
            .map((p) => bot.blockAt(p))
            .filter((b): b is NonNullable<typeof b> => Boolean(b))
            .map((b) => ({
              name: b.name,
              position: { x: b.position.x, y: b.position.y, z: b.position.z },
            }));

          send(ws, ok(request, { blocks: found }));
          return;
        }
        default: {
          send(ws, fail(request, `Unknown request type: ${request.type}`));
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(ws, fail(request, message));
    }
  });

  ws.on("close", () => {
    // no-op; bots are long-lived until destroyed
  });
});

