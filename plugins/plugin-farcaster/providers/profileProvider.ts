import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME } from "../types";
import { getFarcasterFid } from "../utils/config";

const spec = requireProviderSpec("farcasterProfile");
const MAX_PROFILE_FIELD_LENGTH = 280;

function truncateProfileField(value: string | undefined): string | undefined {
  return value ? value.slice(0, MAX_PROFILE_FIELD_LENGTH) : value;
}

export const farcasterProfileProvider: Provider = {
  name: spec.name,
  description: "Provides information about the agent's Farcaster profile",
  descriptionCompressed: "provide information agent Farcaster profile",

  dynamic: true,
  contexts: ["social_posting", "messaging", "connectors"],
  contextGate: { anyOf: ["social_posting", "messaging", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const managers = service?.getActiveManagers();

      if (!managers || managers.size === 0) {
        runtime.logger.debug("[FarcasterProfileProvider] No managers available");
        return {
          text: "Farcaster profile not available.",
          data: { available: false },
        };
      }

      const manager = managers.get(runtime.agentId);
      if (!manager) {
        runtime.logger.debug("[FarcasterProfileProvider] No manager for this agent");
        return {
          text: "Farcaster profile not available for this agent.",
          data: { available: false },
        };
      }

      const fid = getFarcasterFid(runtime);
      if (!fid) {
        runtime.logger.warn("[FarcasterProfileProvider] Invalid or missing FARCASTER_FID");
        return {
          text: "Invalid Farcaster FID configured.",
          data: { available: false, error: "Invalid FID" },
        };
      }

      try {
        const profile = await manager.client.getProfile(fid);
        const username = truncateProfileField(profile.username) ?? "";
        const name = truncateProfileField(profile.name);

        return {
          text: `Your Farcaster profile: @${username} (FID: ${profile.fid}). ${name ? `Display name: ${name}` : ""}`,
          data: {
            available: true,
            fid: profile.fid,
            username,
            name,
            pfp: profile.pfp,
          },
          values: {
            fid: profile.fid,
            username,
          },
        };
      } catch (error) {
        runtime.logger.error(
          "[FarcasterProfileProvider] Error fetching profile:",
          typeof error === "string" ? error : (error as Error).message
        );
        return {
          text: "Unable to fetch Farcaster profile at this time.",
          data: { available: false, error: "Fetch failed" },
        };
      }
    } catch (error) {
      runtime.logger.error(
        "[FarcasterProfileProvider] Error:",
        typeof error === "string" ? error : (error as Error).message
      );
      return {
        text: "Farcaster service is not available.",
        data: { available: false },
      };
    }
  },
};
