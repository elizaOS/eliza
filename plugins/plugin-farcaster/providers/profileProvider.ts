import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME } from "../types";
import { getFarcasterFid, readFarcasterAccountId } from "../utils/config";

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
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const accountId = readFarcasterAccountId(message, state);
      const manager =
        service?.getManagerForAccount?.(accountId, runtime.agentId) ??
        service?.getManagerForAccount?.(undefined, runtime.agentId);

      if (!manager) {
        runtime.logger.debug("[FarcasterProfileProvider] No managers available");
        return {
          text: "Farcaster profile not available.",
          data: { available: false },
        };
      }

      const selectedAccountId = manager.config.accountId;
      const fid = getFarcasterFid(runtime, selectedAccountId);
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
            accountId: selectedAccountId,
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
