import type { RouteRequestContext } from "@elizaos/agent/api";
import {
  type CharacterRouteContext as AutonomousCharacterRouteContext,
  type CharacterRouteState as AutonomousCharacterRouteState,
  handleCharacterRoutes as handleAutonomousCharacterRoutes,
} from "@elizaos/agent/api/character-routes";
import type { ElizaConfig } from "@elizaos/agent/config";
import { CharacterSchema } from "@elizaos/agent/config";

export interface CharacterRouteState extends AutonomousCharacterRouteState {
  config?: ElizaConfig;
}

export interface CharacterRouteContext extends RouteRequestContext {
  state: CharacterRouteState;
  pickRandomNames: (count: number) => string[];
  saveConfig?: (config: ElizaConfig) => void;
}

function toAutonomousContext(
  ctx: CharacterRouteContext,
): AutonomousCharacterRouteContext {
  return {
    ...ctx,
    saveConfig: ctx.saveConfig
      ? (config) => ctx.saveConfig?.(config as ElizaConfig)
      : undefined,
    validateCharacter: (body) => CharacterSchema.safeParse(body) as never,
  };
}

export async function handleCharacterRoutes(
  ctx: CharacterRouteContext,
): Promise<boolean> {
  return handleAutonomousCharacterRoutes(toAutonomousContext(ctx));
}
