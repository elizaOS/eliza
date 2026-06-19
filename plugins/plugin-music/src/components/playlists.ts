import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { v4 } from "uuid";
import {
  createStoredField,
  getStoredField,
  mergeStoredField,
} from "./componentData";
import { ensureAgentStorageContext } from "./storageContext";

/**
 * Represents a track in a playlist
 */
export interface PlaylistTrack {
  url: string;
  title: string;
  duration?: number;
  addedAt?: number;
  requestedBy?: string;
  dedicatedTo?: string;
  dedicationMessage?: string;
}

/**
 * Represents a saved playlist
 */
export interface Playlist {
  id: string;
  name: string;
  tracks: PlaylistTrack[];
  createdAt: number;
  updatedAt: number;
  isFavorite?: boolean;
}

const PLAYLIST_COMPONENT_TYPE = "dj_playlist";

/**
 * Save a playlist to user's entity components
 */
export async function savePlaylist(
  runtime: IAgentRuntime,
  entityId: UUID,
  playlist: Omit<Playlist, "id" | "createdAt" | "updatedAt"> & {
    id?: string;
    createdAt?: number;
  },
): Promise<Playlist> {
  const playlistId = playlist.id || (v4() as string);
  const now = Date.now();

  const fullPlaylist: Playlist = {
    ...playlist,
    id: playlistId,
    createdAt: playlist.createdAt || now,
    updatedAt: now,
  };

  // Get existing playlists component
  const existingComponent = await runtime.getComponent(
    entityId,
    PLAYLIST_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  const playlists =
    getStoredField<Playlist[]>(existingComponent, "playlists") ?? [];

  // Update or add playlist
  const index = playlists.findIndex((p) => p.id === playlistId);
  if (index >= 0) {
    playlists[index] = fullPlaylist;
  } else {
    playlists.push(fullPlaylist);
  }

  // Save to component
  if (existingComponent) {
    await runtime.updateComponent({
      ...existingComponent,
      data: mergeStoredField(existingComponent, "playlists", playlists),
    });
  } else {
    // Get room and world for component creation
    const entity = await runtime.getEntityById(entityId);
    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    const storageContext = await ensureAgentStorageContext(
      runtime,
      "playlists",
      "music-library",
    );

    await runtime.createComponent({
      id: v4() as UUID,
      entityId,
      agentId: runtime.agentId,
      roomId: storageContext.roomId,
      worldId: storageContext.worldId,
      sourceEntityId: runtime.agentId,
      type: PLAYLIST_COMPONENT_TYPE,
      createdAt: now,
      data: createStoredField("playlists", playlists),
    });
  }

  logger.debug(`Saved playlist "${fullPlaylist.name}" for entity ${entityId}`);
  return fullPlaylist;
}

/**
 * Load all playlists for a user
 */
export async function loadPlaylists(
  runtime: IAgentRuntime,
  entityId: UUID,
): Promise<Playlist[]> {
  const component = await runtime.getComponent(
    entityId,
    PLAYLIST_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  return getStoredField<Playlist[]>(component, "playlists") ?? [];
}

/**
 * Delete a playlist
 */
export async function deletePlaylist(
  runtime: IAgentRuntime,
  entityId: UUID,
  playlistId: string,
): Promise<boolean> {
  const component = await runtime.getComponent(
    entityId,
    PLAYLIST_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  if (!component) {
    return false;
  }

  const playlists = getStoredField<Playlist[]>(component, "playlists") ?? [];
  const filtered = playlists.filter((p) => p.id !== playlistId);

  await runtime.updateComponent({
    ...component,
    data: mergeStoredField(component, "playlists", filtered),
  });

  logger.debug(`Deleted playlist ${playlistId} for entity ${entityId}`);
  return true;
}
