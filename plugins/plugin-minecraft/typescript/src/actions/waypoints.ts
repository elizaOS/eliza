import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";
import {
  WAYPOINTS_SERVICE_TYPE,
  type WaypointsService,
} from "../services/waypoints-service.js";

function parseName(text: string): string | null {
  const name = text.trim();
  return name.length > 0 ? name : null;
}

export const minecraftWaypointSetAction: Action = {
  name: "MC_WAYPOINT_SET",
  similes: ["MINECRAFT_WAYPOINT_SET", "SET_WAYPOINT", "SAVE_WAYPOINT"],
  description:
    "Save the bot's current position as a named waypoint (message text is the name).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return (
      Boolean(runtime.getService(WAYPOINTS_SERVICE_TYPE)) &&
      Boolean(parseName(message.content.text ?? ""))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const waypoints = runtime.getService<WaypointsService>(
      WAYPOINTS_SERVICE_TYPE,
    );
    const mc = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    const name = parseName(message.content.text ?? "");
    if (!waypoints || !mc)
      return {
        text: "Waypoint or Minecraft service not available",
        success: false,
      };
    if (!name) return { text: "Missing waypoint name", success: false };

    const ws = await mc.getWorldState();
    const pos = ws.position;
    if (!pos)
      return {
        text: "No position available (is the bot connected?)",
        success: false,
      };

    const wp = await waypoints.setWaypoint(name, pos.x, pos.y, pos.z);
    const content: Content = {
      text: `Saved waypoint "${wp.name}" at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}).`,
      actions: ["MC_WAYPOINT_SET"],
      source: message.content.source,
    };
    await callback?.(content);
    return {
      text: content.text ?? "",
      success: true,
      data: {
        name: wp.name,
        x: wp.x,
        y: wp.y,
        z: wp.z,
        createdAt: wp.createdAt.toISOString(),
      },
    };
  },
};

export const minecraftWaypointDeleteAction: Action = {
  name: "MC_WAYPOINT_DELETE",
  similes: ["MINECRAFT_WAYPOINT_DELETE", "DELETE_WAYPOINT", "REMOVE_WAYPOINT"],
  description: "Delete a named waypoint (message text is the name).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return (
      Boolean(runtime.getService(WAYPOINTS_SERVICE_TYPE)) &&
      Boolean(parseName(message.content.text ?? ""))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const waypoints = runtime.getService<WaypointsService>(
      WAYPOINTS_SERVICE_TYPE,
    );
    const name = parseName(message.content.text ?? "");
    if (!waypoints)
      return { text: "Waypoints service not available", success: false };
    if (!name) return { text: "Missing waypoint name", success: false };

    const deleted = await waypoints.deleteWaypoint(name);
    const content: Content = {
      text: deleted
        ? `Deleted waypoint "${name}".`
        : `No waypoint named "${name}".`,
      actions: ["MC_WAYPOINT_DELETE"],
      source: message.content.source,
    };
    await callback?.(content);
    return { text: content.text ?? "", success: deleted, values: { deleted } };
  },
};

export const minecraftWaypointListAction: Action = {
  name: "MC_WAYPOINT_LIST",
  similes: ["MINECRAFT_WAYPOINT_LIST", "LIST_WAYPOINTS", "SHOW_WAYPOINTS"],
  description: "List saved waypoints.",
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(runtime.getService(WAYPOINTS_SERVICE_TYPE));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const waypoints = runtime.getService<WaypointsService>(
      WAYPOINTS_SERVICE_TYPE,
    );
    if (!waypoints)
      return { text: "Waypoints service not available", success: false };
    const list = waypoints.listWaypoints();
    const lines = list.map(
      (w) =>
        `- ${w.name}: (${w.x.toFixed(1)}, ${w.y.toFixed(1)}, ${w.z.toFixed(1)})`,
    );
    const content: Content = {
      text: list.length
        ? `Waypoints:\n${lines.join("\n")}`
        : "No waypoints saved.",
      actions: ["MC_WAYPOINT_LIST"],
      source: message.content.source,
    };
    await callback?.(content);
    return {
      text: content.text ?? "",
      success: true,
      data: {
        waypoints: list.map((w) => ({
          name: w.name,
          x: w.x,
          y: w.y,
          z: w.z,
          createdAt: w.createdAt.toISOString(),
        })),
      },
    };
  },
};

export const minecraftWaypointGotoAction: Action = {
  name: "MC_WAYPOINT_GOTO",
  similes: ["MINECRAFT_WAYPOINT_GOTO", "GOTO_WAYPOINT", "NAVIGATE_WAYPOINT"],
  description: "Pathfind to a named waypoint (message text is the name).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    return (
      Boolean(runtime.getService(WAYPOINTS_SERVICE_TYPE)) &&
      Boolean(runtime.getService(MINECRAFT_SERVICE_TYPE)) &&
      Boolean(parseName(message.content.text ?? ""))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const waypoints = runtime.getService<WaypointsService>(
      WAYPOINTS_SERVICE_TYPE,
    );
    const mc = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    const name = parseName(message.content.text ?? "");
    if (!waypoints || !mc)
      return {
        text: "Waypoint or Minecraft service not available",
        success: false,
      };
    if (!name) return { text: "Missing waypoint name", success: false };

    const wp = waypoints.getWaypoint(name);
    if (!wp) {
      const content: Content = {
        text: `No waypoint named "${name}".`,
        actions: ["MC_WAYPOINT_GOTO"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }

    await mc.request("goto", { x: wp.x, y: wp.y, z: wp.z });
    const content: Content = {
      text: `Navigating to waypoint "${wp.name}" at (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)}).`,
      actions: ["MC_WAYPOINT_GOTO"],
      source: message.content.source,
    };
    await callback?.(content);
    return { text: content.text ?? "", success: true };
  },
};
