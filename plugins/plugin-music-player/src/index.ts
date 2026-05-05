import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import { manageRouting } from "./actions/manageRouting";
import { manageZones } from "./actions/manageZones";
import { pauseMusic, resumeMusic } from "./actions/pauseResumeMusic";
import { playAudio } from "./actions/playAudio";
import { queueMusic } from "./actions/queueMusic";
import { showQueue } from "./actions/showQueue";
import { skipTrack } from "./actions/skipTrack";
import { stopMusic } from "./actions/stopMusic";
import { musicPlayerRoutes } from "./routes";
import { installProcessActionsTransportPatch } from "./runtime/processActionsTransportPatch";
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

const musicPlayerPlugin: Plugin = {
  name: "music-player",
  description:
    "Pure music playback engine with queue management, cross-fading, smart music fetching, and audio streaming API",
  services: [MusicService],
  // Transport controls listed before PLAY_AUDIO so prompts tend to prefer them
  // for pause/skip/stop/resume (PLAY_AUDIO validate rejects transport-only text).
  actions: [
    pauseMusic,
    resumeMusic,
    stopMusic,
    skipTrack,
    manageRouting,
    manageZones,
    playAudio,
    queueMusic,
    showQueue,
  ],
  providers: [],
  routes: musicPlayerRoutes,
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    installProcessActionsTransportPatch(runtime);

    // Don't block init - set up services after initialization completes
    runtime
      .getServiceLoadPromise("discord" as any)
      .then(async (discordService) => {
        if (!discordService) {
          logger.warn(
            "Discord service not found - Music Player plugin will work in web-only mode",
          );
          return;
        }

        // Wait for Discord client to be ready before accessing voiceManager
        if ((discordService as any).clientReadyPromise) {
          logger.debug(
            "Music Player waiting for Discord client to be ready...",
          );
          await (discordService as any).clientReadyPromise;
        }

        runtime
          .getServiceLoadPromise("music" as any)
          .then((musicService: any) => {
            if (!musicService) {
              logger.warn(
                "Music service not available - Music Player plugin initialization incomplete",
              );
              return;
            }

            // Initialize music service with voice manager from Discord service
            const voiceManager = (discordService as any).voiceManager;
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
