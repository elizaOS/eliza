/**
 * Plugin entry for the Spotify integration: assembles the `Plugin` object
 * (registering `SpotifyService` and the SPOTIFY umbrella action) and
 * re-exports the package's public surface. The `init()` hook registers the
 * connector-account provider with the runtime's `ConnectorAccountManager` so
 * managed OAuth (cloud) can list, connect, and revoke Spotify accounts;
 * self-hosted local mode needs no manager and works from SPOTIFY_* settings
 * alone, so a missing manager is a warning rather than a failure.
 */
import { getConnectorAccountManager, logger, type Plugin } from "@elizaos/core";
import { spotifyAction } from "./actions";
import { createSpotifyConnectorAccountProvider } from "./connector-account-provider";
import { SpotifyService } from "./service";
import { SPOTIFY_SERVICE_NAME } from "./types";

const spotifyPlugin: Plugin = {
  name: SPOTIFY_SERVICE_NAME,
  description:
    "Spotify music integration: search, saved-track library, playlists, playback control, and device handoff",
  actions: [spotifyAction],
  providers: [],
  services: [SpotifyService],
  async init(_config, runtime) {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createSpotifyConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:spotify",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Spotify provider with ConnectorAccountManager"
      );
    }
  },
};

export { spotifyAction, spotifyActions } from "./actions";
export {
  exchangeAuthorizationCode,
  hasLocalConfig,
  readLocalConfig,
  refreshAccessToken,
  SPOTIFY_OAUTH_SCOPES,
} from "./auth";
export { SpotifyApiClient } from "./client";
export {
  createSpotifyConnectorAccountProvider,
  SPOTIFY_PROVIDER_ID,
} from "./connector-account-provider";
export { SpotifyService } from "./service";
export * from "./types";
export default spotifyPlugin;
