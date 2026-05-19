// Shared utilities for plugin-ainex actions. Each action resolves the
// AinexService, sends one or more bridge commands, and returns an ActionResult
// the agent can surface back to the user.

import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
} from "@elizaos/core";
import type { AinexBridgeClient } from "../bridge-client";
import { AinexService } from "../service";
import type { BridgeCommand, JsonDict } from "../types";

export function getService(runtime: IAgentRuntime): AinexService | null {
  return (
    runtime.getService<AinexService>(AinexService.serviceType) ?? null
  );
}

export function getBridge(runtime: IAgentRuntime): AinexBridgeClient | null {
  return getService(runtime)?.getBridge() ?? null;
}

export async function notConnected(
  callback: HandlerCallback | undefined,
  context: string,
): Promise<ActionResult> {
  const text = `AiNex bridge is not connected (${context}); start the bridge with \`python -m eliza_robot.bridge.launch --target mujoco\` and retry.`;
  await callback?.({ text });
  return { success: false, text };
}

/**
 * Send a single bridge command, await its response, and emit a chat reply.
 * On success, success=true and the reply uses `okText`; on failure, success=false
 * and the reply includes the server message.
 */
export async function sendOne(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  command: BridgeCommand,
  payload: JsonDict,
  okText: string,
  failContext: string,
  preempt = false,
): Promise<ActionResult> {
  const bridge = getBridge(runtime);
  if (!bridge || !bridge.isConnected()) {
    return notConnected(callback, failContext);
  }
  const response = await bridge.send(command, payload, { preempt });
  if (!response.ok) {
    const text = `AiNex ${failContext} failed: ${response.message}`;
    await callback?.({ text });
    return { success: false, text };
  }
  await callback?.({ text: okText });
  return { success: true, text: okText, data: response.data };
}

/**
 * Send a `walk.set` + `walk.command:start` pair (fire-and-forget). The action
 * resolves once the bridge has acknowledged both; the robot will keep walking
 * with the given velocity until the agent issues `AINEX_STOP`.
 */
export async function startWalking(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  velocity: { x: number; y: number; yaw: number; speed?: number; height?: number },
  okText: string,
  context: string,
): Promise<ActionResult> {
  const bridge = getBridge(runtime);
  if (!bridge || !bridge.isConnected()) {
    return notConnected(callback, context);
  }
  const speed = velocity.speed ?? 2;
  const height = velocity.height ?? 0.036;

  const setResponse = await bridge.send(
    "walk.set",
    {
      speed,
      height,
      x: velocity.x,
      y: velocity.y,
      yaw: velocity.yaw,
    },
  );
  if (!setResponse.ok) {
    const text = `AiNex ${context} (walk.set) failed: ${setResponse.message}`;
    await callback?.({ text });
    return { success: false, text };
  }
  const startResponse = await bridge.send("walk.command", { action: "start" });
  if (!startResponse.ok) {
    const text = `AiNex ${context} (walk.command:start) failed: ${startResponse.message}`;
    await callback?.({ text });
    return { success: false, text };
  }
  await callback?.({ text: okText });
  return { success: true, text: okText, data: startResponse.data };
}

/** Parse a numeric option from action options, returning fallback if absent. */
export function getNumberOption(
  options: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Parse a string option from action options, returning fallback if absent. */
export function getStringOption(
  options: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = options?.[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}
