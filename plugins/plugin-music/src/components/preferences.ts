import type { IAgentRuntime, UUID } from "@elizaos/core";
import { v4 } from "uuid";
import {
  createStoredField,
  getStoredField,
  mergeStoredField,
} from "./componentData";
import { requireRoomContext } from "./storageContext";

/**
 * User music preferences
 */
export interface UserMusicPreferences {
  favoriteGenres?: string[];
  favoriteArtists?: string[];
  favoriteTracks?: Array<{ url: string; title: string; playCount?: number }>;
  dislikedTracks?: string[]; // URLs
  skipHistory?: Array<{ url: string; timestamp: number }>;
  requestHistory?: Array<{ url: string; title: string; timestamp: number }>;
  listeningSessions?: Array<{
    startTime: number;
    endTime?: number;
    tracksPlayed: number;
  }>;
}

const PREFERENCES_COMPONENT_TYPE = "dj_preferences";

/**
 * Update user music preferences
 */
export async function updateUserPreferences(
  runtime: IAgentRuntime,
  entityId: UUID,
  preferences: Partial<UserMusicPreferences>,
  roomId?: UUID,
  worldId?: UUID,
): Promise<UserMusicPreferences> {
  // Try to get existing component with proper filtering
  const existingComponent = await runtime.getComponent(
    entityId,
    PREFERENCES_COMPONENT_TYPE,
    worldId,
    runtime.agentId,
  );

  const current =
    getStoredField<UserMusicPreferences>(existingComponent, "preferences") ??
    {};

  const updated: UserMusicPreferences = {
    ...current,
    ...preferences,
    // Merge arrays
    favoriteGenres: [
      ...new Set([
        ...(current.favoriteGenres || []),
        ...(preferences.favoriteGenres || []),
      ]),
    ],
    favoriteArtists: [
      ...new Set([
        ...(current.favoriteArtists || []),
        ...(preferences.favoriteArtists || []),
      ]),
    ],
    favoriteTracks: mergeFavoriteTracks(
      current.favoriteTracks || [],
      preferences.favoriteTracks || [],
    ),
    dislikedTracks: [
      ...new Set([
        ...(current.dislikedTracks || []),
        ...(preferences.dislikedTracks || []),
      ]),
    ],
    skipHistory: [
      ...(current.skipHistory || []),
      ...(preferences.skipHistory || []),
    ].slice(-100), // Keep last 100
    requestHistory: [
      ...(current.requestHistory || []),
      ...(preferences.requestHistory || []),
    ].slice(-100),
    listeningSessions: [
      ...(current.listeningSessions || []),
      ...(preferences.listeningSessions || []),
    ].slice(-50),
  };

  if (existingComponent) {
    await runtime.updateComponent({
      ...existingComponent,
      data: mergeStoredField(existingComponent, "preferences", updated),
    });
  } else {
    const entity = await runtime.getEntityById(entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    if (!roomId) {
      throw new Error(
        "[DJ Preferences] roomId is required when creating a preferences component",
      );
    }

    const roomContext = await requireRoomContext(
      runtime,
      roomId,
      "DJ Preferences",
    );
    if (worldId && worldId !== roomContext.worldId) {
      throw new Error(
        `[DJ Preferences] worldId ${worldId} does not match room ${roomId} world ${roomContext.worldId}`,
      );
    }

    await runtime.createComponent({
      id: v4() as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId: roomContext.roomId,
      worldId: roomContext.worldId,
      sourceEntityId: runtime.agentId,
      type: PREFERENCES_COMPONENT_TYPE,
      createdAt: Date.now(),
      data: createStoredField("preferences", updated),
    });
  }

  return updated;
}

/**
 * Get user music preferences
 */
export async function getUserPreferences(
  runtime: IAgentRuntime,
  entityId: UUID,
): Promise<UserMusicPreferences | null> {
  const component = await runtime.getComponent(
    entityId,
    PREFERENCES_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  return getStoredField<UserMusicPreferences>(component, "preferences");
}

/**
 * Get preferences for all users in a room
 */
export async function getRoomPreferences(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<Map<UUID, UserMusicPreferences>> {
  const entities = await runtime.getEntitiesForRoom(roomId, true);
  const preferences = new Map<UUID, UserMusicPreferences>();

  for (const entity of entities) {
    if (!entity.id) {
      continue;
    }

    const prefs = await getUserPreferences(runtime, entity.id);
    if (prefs) {
      preferences.set(entity.id, prefs);
    }
  }

  return preferences;
}

/**
 * Merge favorite tracks, incrementing play count
 */
function mergeFavoriteTracks(
  current: UserMusicPreferences["favoriteTracks"],
  newTracks: UserMusicPreferences["favoriteTracks"],
): UserMusicPreferences["favoriteTracks"] {
  if (!newTracks || newTracks.length === 0) {
    return current || [];
  }

  type FavoriteTrack = NonNullable<UserMusicPreferences["favoriteTracks"]>[0];
  const trackMap = new Map<string, FavoriteTrack>();

  // Add existing tracks
  (current || []).forEach((track) => {
    trackMap.set(track.url, { ...track, playCount: track.playCount || 1 });
  });

  // Add/update new tracks
  newTracks.forEach((track) => {
    const existing = trackMap.get(track.url);
    if (existing) {
      trackMap.set(track.url, {
        ...existing,
        playCount: (existing.playCount || 1) + 1,
      });
    } else {
      trackMap.set(track.url, { ...track, playCount: 1 });
    }
  });

  return Array.from(trackMap.values()).sort(
    (a, b) => (b.playCount || 0) - (a.playCount || 0),
  );
}

/**
 * Track a track request
 */
export async function trackTrackRequest(
  runtime: IAgentRuntime,
  entityId: UUID,
  track: { url: string; title: string },
  roomId?: UUID,
  worldId?: UUID,
): Promise<void> {
  await updateUserPreferences(
    runtime,
    entityId,
    {
      requestHistory: [
        {
          url: track.url,
          title: track.title,
          timestamp: Date.now(),
        },
      ],
    },
    roomId,
    worldId,
  );
}

/**
 * Track a skip
 */
export async function trackSkip(
  runtime: IAgentRuntime,
  entityId: UUID,
  trackUrl: string,
  roomId?: UUID,
  worldId?: UUID,
): Promise<void> {
  await updateUserPreferences(
    runtime,
    entityId,
    {
      skipHistory: [
        {
          url: trackUrl,
          timestamp: Date.now(),
        },
      ],
    },
    roomId,
    worldId,
  );
}

/**
 * Track favorite track
 */
export async function trackFavorite(
  runtime: IAgentRuntime,
  entityId: UUID,
  track: { url: string; title: string },
  roomId?: UUID,
  worldId?: UUID,
): Promise<void> {
  await updateUserPreferences(
    runtime,
    entityId,
    {
      favoriteTracks: [track],
    },
    roomId,
    worldId,
  );
}
