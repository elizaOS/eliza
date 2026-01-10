/**
 * Test suite for Farcaster plugin.
 */

import type { IAgentRuntime, TestSuite, Test } from "@elizaos/core";
import { FARCASTER_SERVICE_NAME } from "../types";
import type { FarcasterService } from "../services/FarcasterService";
import { getFarcasterFid, hasFarcasterEnabled } from "../utils/config";

const farcasterTests: Test[] = [
  {
    name: "farcaster_config_validation",
    fn: async (runtime: IAgentRuntime) => {
      const hasConfig = hasFarcasterEnabled(runtime);
      if (!hasConfig) {
        throw new Error("Farcaster is not properly configured");
      }
      runtime.logger.info("Farcaster configuration validated");
    },
  },
  {
    name: "farcaster_service_available",
    fn: async (runtime: IAgentRuntime) => {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error("Farcaster service not found");
      }
      runtime.logger.info("Farcaster service is available");
    },
  },
  {
    name: "farcaster_profile_fetch",
    fn: async (runtime: IAgentRuntime) => {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error("Farcaster service not found");
      }

      const managers = service.getActiveManagers();
      const manager = managers.get(runtime.agentId);
      if (!manager) {
        throw new Error("Farcaster manager not found for agent");
      }

      const fid = getFarcasterFid(runtime);
      if (!fid) {
        throw new Error("FARCASTER_FID not configured");
      }

      const profile = await manager.client.getProfile(fid);
      if (!profile || !profile.username) {
        throw new Error("Failed to fetch profile");
      }

      runtime.logger.info(`Fetched profile: @${profile.username} (FID: ${profile.fid})`);
    },
  },
  {
    name: "farcaster_cast_service_available",
    fn: async (runtime: IAgentRuntime) => {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error("Farcaster service not found");
      }

      const castService = service.getCastService(runtime.agentId);
      if (!castService) {
        throw new Error("Cast service not found for agent");
      }

      runtime.logger.info("Cast service is available");
    },
  },
  {
    name: "farcaster_message_service_available",
    fn: async (runtime: IAgentRuntime) => {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error("Farcaster service not found");
      }

      const messageService = service.getMessageService(runtime.agentId);
      if (!messageService) {
        throw new Error("Message service not found for agent");
      }

      runtime.logger.info("Message service is available");
    },
  },
];

export class FarcasterTestSuite implements TestSuite {
  name = "farcaster_plugin_tests";
  tests = farcasterTests;
}

