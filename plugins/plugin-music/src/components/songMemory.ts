import { createUniqueUuid, type IAgentRuntime, type UUID } from "@elizaos/core";
import { v4 } from "uuid";
import {
  createStoredField,
  getStoredField,
  mergeStoredField,
} from "./componentData";
import { ensureAgentStorageContext } from "./storageContext";

/**
 * Detailed per-song memory and statistics
 * Tracks everything about a song across all rooms
 */
export interface SongMemory {
  // Identity
  url: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;

  // Play Statistics
  totalPlays: number;
  totalPlayTime: number; // milliseconds
  lastPlayed: number;
  firstPlayed: number;

  // Request Statistics
  totalRequests: number;
  uniqueRequesters: number;
  topRequesters: Array<{ entityId: UUID; name: string; count: number }>;

  // Engagement
  totalLikes: number; // Future: reaction tracking
  totalDislikes: number;
  skipCount: number; // Times users skipped this song
  completionRate: number; // % of times played to completion

  // Context
  playedInRooms: Array<{ roomId: UUID; playCount: number; lastPlayed: number }>;
  dedicationCount: number;
  dedications: Array<{
    from: string;
    to: string;
    message?: string;
    timestamp: number;
  }>;

  // Timing Patterns
  popularHours: number[]; // 24-element array, play count per hour
  popularDays: number[]; // 7-element array, play count per day

  // Performance Metrics
  averageListenerCount: number;
  peakListenerCount: number;
  listenerEngagement: number; // 0-100 score

  // Metadata
  createdAt: number;
  updatedAt: number;
  tags?: string[]; // Genre, mood, etc
  notes?: string; // DJ notes about the song
}

const SONG_MEMORY_COMPONENT_TYPE = "song_memory";
const SONG_MEMORY_ENTITY_PREFIX = "song-memory";

function getSongMemoryEntityId(runtime: IAgentRuntime, url: string): UUID {
  return createUniqueUuid(runtime, `${SONG_MEMORY_ENTITY_PREFIX}-${url}`);
}

/**
 * Get song memory
 */
export async function getSongMemory(
  runtime: IAgentRuntime,
  url: string,
): Promise<SongMemory | null> {
  const entityId = getSongMemoryEntityId(runtime, url);
  const component = await runtime.getComponent(
    entityId,
    SONG_MEMORY_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  return getStoredField<SongMemory>(component, "memory");
}

/**
 * Create initial song memory
 */
async function createSongMemory(
  runtime: IAgentRuntime,
  song: {
    url: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
  },
): Promise<SongMemory> {
  const entityId = getSongMemoryEntityId(runtime, song.url);

  const memory: SongMemory = {
    url: song.url,
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    totalPlays: 0,
    totalPlayTime: 0,
    lastPlayed: 0,
    firstPlayed: Date.now(),
    totalRequests: 0,
    uniqueRequesters: 0,
    topRequesters: [],
    totalLikes: 0,
    totalDislikes: 0,
    skipCount: 0,
    completionRate: 100,
    playedInRooms: [],
    dedicationCount: 0,
    dedications: [],
    popularHours: Array(24).fill(0),
    popularDays: Array(7).fill(0),
    averageListenerCount: 0,
    peakListenerCount: 0,
    listenerEngagement: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const storageContext = await ensureAgentStorageContext(
    runtime,
    "song-memory",
    "music-library",
  );

  await runtime.createComponent({
    id: v4() as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId: storageContext.roomId,
    worldId: storageContext.worldId,
    sourceEntityId: runtime.agentId,
    type: SONG_MEMORY_COMPONENT_TYPE,
    createdAt: Date.now(),
    data: createStoredField("memory", memory),
  });

  return memory;
}

/**
 * Record a play
 */
export async function recordSongPlay(
  runtime: IAgentRuntime,
  song: {
    url: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
  },
  context: {
    roomId?: UUID;
    playDuration: number; // milliseconds actually played
    listenerCount?: number;
    requestedBy?: { entityId: UUID; name: string };
    wasSkipped?: boolean;
  },
): Promise<void> {
  let memory = await getSongMemory(runtime, song.url);

  if (!memory) {
    memory = await createSongMemory(runtime, song);
  }

  const now = Date.now();
  const hour = new Date(now).getHours();
  const day = new Date(now).getDay();

  // Update play statistics
  memory.totalPlays++;
  memory.totalPlayTime += context.playDuration;
  memory.lastPlayed = now;
  memory.updatedAt = now;

  // Update timing patterns
  memory.popularHours[hour]++;
  memory.popularDays[day]++;

  // Update room statistics
  if (context.roomId) {
    const roomStat = memory.playedInRooms.find(
      (r) => r.roomId === context.roomId,
    );
    if (roomStat) {
      roomStat.playCount++;
      roomStat.lastPlayed = now;
    } else {
      memory.playedInRooms.push({
        roomId: context.roomId,
        playCount: 1,
        lastPlayed: now,
      });
    }
  }

  // Update listener metrics
  if (context.listenerCount !== undefined) {
    const totalListeners =
      memory.averageListenerCount * (memory.totalPlays - 1) +
      context.listenerCount;
    memory.averageListenerCount = totalListeners / memory.totalPlays;
    memory.peakListenerCount = Math.max(
      memory.peakListenerCount,
      context.listenerCount,
    );
  }

  // Update skip/completion rate
  if (context.wasSkipped) {
    memory.skipCount++;
  }

  const expectedDuration = song.duration || 180000; // Default 3 minutes
  const completionPercent = (context.playDuration / expectedDuration) * 100;
  const totalCompletion =
    memory.completionRate * (memory.totalPlays - 1) + completionPercent;
  memory.completionRate = totalCompletion / memory.totalPlays;

  // Save
  await updateSongMemory(runtime, song.url, memory);
}

/**
 * Record a request
 */
export async function recordSongRequest(
  runtime: IAgentRuntime,
  song: {
    url: string;
    title: string;
    artist?: string;
    album?: string;
    duration?: number;
  },
  requester: {
    entityId: UUID;
    name: string;
  },
): Promise<void> {
  let memory = await getSongMemory(runtime, song.url);

  if (!memory) {
    memory = await createSongMemory(runtime, song);
  }

  memory.totalRequests++;
  memory.updatedAt = Date.now();

  // Update top requesters
  const requesterStat = memory.topRequesters.find(
    (r) => r.entityId === requester.entityId,
  );
  if (requesterStat) {
    requesterStat.count++;
  } else {
    memory.topRequesters.push({
      entityId: requester.entityId,
      name: requester.name,
      count: 1,
    });
    memory.uniqueRequesters++;
  }

  // Sort and keep top 10
  memory.topRequesters.sort((a, b) => b.count - a.count);
  memory.topRequesters = memory.topRequesters.slice(0, 10);

  await updateSongMemory(runtime, song.url, memory);
}

/**
 * Record a dedication
 */
export async function recordSongDedication(
  runtime: IAgentRuntime,
  url: string,
  dedication: {
    from: string;
    to: string;
    message?: string;
  },
): Promise<void> {
  const memory = await getSongMemory(runtime, url);
  if (!memory) {
    throw new Error(
      `[Song Memory] Cannot record dedication for unknown song ${url}`,
    );
  }

  memory.dedicationCount++;
  memory.dedications.push({
    ...dedication,
    timestamp: Date.now(),
  });

  // Keep only last 50 dedications
  if (memory.dedications.length > 50) {
    memory.dedications = memory.dedications.slice(-50);
  }

  memory.updatedAt = Date.now();
  await updateSongMemory(runtime, url, memory);
}

/**
 * Update song memory
 */
async function updateSongMemory(
  runtime: IAgentRuntime,
  url: string,
  memory: SongMemory,
): Promise<void> {
  const entityId = getSongMemoryEntityId(runtime, url);
  const component = await runtime.getComponent(
    entityId,
    SONG_MEMORY_COMPONENT_TYPE,
    undefined,
    runtime.agentId,
  );

  if (!component) {
    throw new Error(`[Song Memory] Component not found for ${url}`);
  }

  await runtime.updateComponent({
    ...component,
    data: mergeStoredField(component, "memory", memory),
  });
}

/**
 * Get top songs by play count
 */
export async function getTopSongs(
  _runtime: IAgentRuntime,
  _limit: number = 10,
): Promise<SongMemory[]> {
  throw new Error(
    "[Song Memory] getTopSongs requires runtime-level component indexing support",
  );
}

/**
 * Get most requested songs
 */
export async function getMostRequestedSongs(
  _runtime: IAgentRuntime,
  _limit: number = 10,
): Promise<SongMemory[]> {
  throw new Error(
    "[Song Memory] getMostRequestedSongs requires runtime-level component indexing support",
  );
}
