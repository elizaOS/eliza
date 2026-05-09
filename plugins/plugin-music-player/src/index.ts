import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { manageRouting } from "./actions/manageRouting";
import { manageZones } from "./actions/manageZones";
import { playAudio } from "./actions/playAudio";
import { playbackOp } from "./actions/playbackOp";
import { musicQueueProvider } from "./providers/musicQueueProvider";
import { musicPlayerRoutes } from "./routes";
import { MusicService } from "./service";

// Export audio broadcast contracts
export type {
  AudioSubscription,
  BroadcastState,
  BroadcastTrackMetadata,
  IAudioBroadcast,
} from "./contracts";
// Export broadcast core components
export { Broadcast } from "./core";
// Export types for use by other plugins
export type { CrossFadeOptions, QueuedTrack } from "./queue";
// Export router components for multi-bot support
export {
  type AudioRouteConfig,
  AudioRouter,
  type AudioRoutingMode,
  type MixConfig,
  type MixSession,
  MixSessionManager,
  type Zone,
  ZoneManager,
} from "./router";
export { MusicService } from "./service";
export type {
  FetchProgress,
  FetchResult,
  SmartFetchOptions,
} from "./services/smartMusicFetch";
export { SmartMusicFetchService } from "./services/smartMusicFetch";

interface DiscordMusicBridgeService {
  clientReadyPromise?: Promise<void> | null;
  voiceManager?: Parameters<MusicService["setVoiceManager"]>[0];
}

const musicPlayerPlugin: Plugin = {
  name: "music-player",
  description:
    "Pure music playback engine with queue management, cross-fading, smart music fetching, and audio streaming API",
  services: [MusicService],
  // PLAYBACK_OP listed before PLAY_AUDIO so prompts prefer it for transport
  // (pause/resume/skip/stop/queue). PLAY_AUDIO validate rejects transport-only
  // text so the planner falls back to PLAYBACK_OP.
  actions: [playbackOp, manageRouting, manageZones, playAudio],
  providers: [musicQueueProvider],
  routes: musicPlayerRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // Don't block init - set up services after initialization completes
    runtime
      .getServiceLoadPromise("discord")
      .then(async (service) => {
        const discordService = service as DiscordMusicBridgeService | null;
        if (!discordService) {
          logger.warn(
            "Discord service not found - Music Player plugin will work in web-only mode",
          );
          return;
        }

        // Wait for Discord client to be ready before accessing voiceManager
        if (discordService.clientReadyPromise) {
          logger.debug(
            "Music Player waiting for Discord client to be ready...",
          );
          await discordService.clientReadyPromise;
        }

        runtime
          .getServiceLoadPromise("music")
          .then((service) => {
            const musicService = service as MusicService | null;
            if (!musicService) {
              logger.warn(
                "Music service not available - Music Player plugin initialization incomplete",
              );
              return;
            }

            // Initialize music service with voice manager from Discord service
            const voiceManager = discordService.voiceManager;
            if (voiceManager) {
              musicService.setVoiceManager(voiceManager);
              logger.debug(
                "Music service initialized with Discord voice manager",
              );
            } else {
              logger.warn(
                "Discord voice manager not available - Music Player will work in web-only mode",
              );
            }
          })
          .catch((error) => {
            logger.error(`Error setting up music service: ${error}`);
          });
      })
      .catch((error) => {
        logger.warn(
          `Discord service not available - running in web-only mode: ${error}`,
        );
      });

    logger.debug("Music Player plugin init complete (service setup deferred)");
  },
};

export default musicPlayerPlugin;
