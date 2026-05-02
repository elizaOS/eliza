/**
 * Desktop helper for elizaOS plugin-music-player HTTP routes.
 *
 * Those routes are mounted on the agent HTTP server outside `/api` (e.g.
 * `/music-player/stream`). The main process resolves the same loopback base URL
 * as the embedded agent so the renderer can attach `<audio>` or poll JSON.
 */

import { resolveInitialApiBase } from "../api-base";
import { getBrandConfig } from "../brand-config";
import type { MusicPlayerDesktopPlaybackUrls } from "../rpc-schema";
import { getAgentManager } from "./agent";

/** Default guild/room id when no Discord guild exists (desktop / web-only). */
export const DEFAULT_DESKTOP_MUSIC_GUILD_ID =
	getBrandConfig().desktopMusicGuildId;

export class MusicPlayerManager {
	getDesktopPlaybackUrls(params?: {
		guildId?: string;
	}): MusicPlayerDesktopPlaybackUrls {
		const env = process.env as Record<string, string | undefined>;
		const livePort = getAgentManager().getPort();
		const fromEmbedded =
			typeof livePort === "number" && livePort > 0
				? `http://127.0.0.1:${livePort}`
				: null;
		const apiBase = fromEmbedded ?? resolveInitialApiBase(env);
		if (!apiBase) {
			return {
				ok: false,
				reason:
					"Could not resolve agent API base (check ELIZA_API_PORT / embedded agent)",
			};
		}

		const guildId = params?.guildId?.trim() || DEFAULT_DESKTOP_MUSIC_GUILD_ID;
		const g = encodeURIComponent(guildId);
		const base = apiBase.replace(/\/$/, "");

		return {
			ok: true,
			apiBase: base,
			guildId,
			streamUrl: `${base}/music-player/stream?guildId=${g}`,
			nowPlayingUrl: `${base}/music-player/now-playing?guildId=${g}`,
			queueUrl: `${base}/music-player/queue?guildId=${g}`,
		};
	}

	dispose(): void {}
}

let musicPlayerManager: MusicPlayerManager | null = null;

export function getMusicPlayerManager(): MusicPlayerManager {
	if (!musicPlayerManager) {
		musicPlayerManager = new MusicPlayerManager();
	}
	return musicPlayerManager;
}
