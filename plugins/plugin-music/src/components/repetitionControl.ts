import { logger } from "@elizaos/core";

/**
 * Track play history for repetition control
 */
interface PlayHistoryEntry {
  url: string;
  title: string;
  playedAt: number;
}

/**
 * Smart repetition control to avoid playing same songs too frequently
 */
export class RepetitionControl {
  private playHistory: Map<string, PlayHistoryEntry[]> = new Map(); // key: guildId
  private readonly MAX_HISTORY_SIZE = 100; // Keep last 100 plays per guild
  private readonly MIN_REPLAY_INTERVAL = 60 * 60 * 1000; // 1 hour minimum between replays

  /**
   * Record a track play
   */
  recordPlay(guildId: string, url: string, title: string): void {
    if (!this.playHistory.has(guildId)) {
      this.playHistory.set(guildId, []);
    }

    const history = this.playHistory.get(guildId);
    if (!history) {
      throw new Error(
        `[RepetitionControl] Missing play history bucket for guild ${guildId}`,
      );
    }
    history.push({
      url,
      title,
      playedAt: Date.now(),
    });

    // Trim history to max size
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.shift();
    }
  }

  /**
   * Check if a track can be played (not played too recently)
   */
  canPlay(guildId: string, url: string, minInterval?: number): boolean {
    const history = this.playHistory.get(guildId);
    if (!history || history.length === 0) {
      return true;
    }

    const interval = minInterval || this.MIN_REPLAY_INTERVAL;
    const now = Date.now();

    // Find last time this track was played
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].url === url) {
        const timeSincePlay = now - history[i].playedAt;
        if (timeSincePlay < interval) {
          logger.debug(
            `Repetition control: ${url} played ${Math.round(timeSincePlay / 1000 / 60)} minutes ago (min: ${interval / 1000 / 60} minutes)`,
          );
          return false;
        }
        break;
      }
    }

    return true;
  }

  /**
   * Get recently played tracks for a guild
   */
  getRecentlyPlayed(guildId: string, count: number = 10): PlayHistoryEntry[] {
    const history = this.playHistory.get(guildId);
    if (!history || history.length === 0) {
      return [];
    }

    return history.slice(-count).reverse();
  }

  /**
   * Filter tracks to avoid repetition
   */
  filterRepetition(
    guildId: string,
    tracks: Array<{ url: string; title: string }>,
    minInterval?: number,
  ): Array<{ url: string; title: string }> {
    return tracks.filter((track) =>
      this.canPlay(guildId, track.url, minInterval),
    );
  }

  /**
   * Get play count for a track in recent history
   */
  getRecentPlayCount(
    guildId: string,
    url: string,
    timeWindow: number = 24 * 60 * 60 * 1000,
  ): number {
    const history = this.playHistory.get(guildId);
    if (!history || history.length === 0) {
      return 0;
    }

    const now = Date.now();
    let count = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (now - entry.playedAt > timeWindow) {
        break; // History is ordered, stop checking
      }
      if (entry.url === url) {
        count++;
      }
    }

    return count;
  }

  /**
   * Score tracks based on variety (lower score = played less recently)
   */
  scoreByVariety(
    guildId: string,
    tracks: Array<{ url: string; title: string; playCount?: number }>,
  ): Array<{
    url: string;
    title: string;
    playCount?: number;
    varietyScore: number;
  }> {
    const history = this.playHistory.get(guildId);
    const now = Date.now();

    return tracks.map((track) => {
      let score = 0;

      if (history && history.length > 0) {
        // Find all plays of this track in history
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].url === track.url) {
            const timeSincePlay = now - history[i].playedAt;
            const hoursAgo = timeSincePlay / (1000 * 60 * 60);

            // Score penalty decreases over time
            // Recent plays: high penalty, older plays: low penalty
            if (hoursAgo < 1) {
              score += 100; // Played in last hour
            } else if (hoursAgo < 3) {
              score += 50; // Played in last 3 hours
            } else if (hoursAgo < 6) {
              score += 25; // Played in last 6 hours
            } else if (hoursAgo < 24) {
              score += 10; // Played in last day
            } else {
              score += 1; // Played more than a day ago
            }
          }
        }
      }

      return {
        ...track,
        varietyScore: score,
      };
    });
  }

  /**
   * Clear history for a guild
   */
  clearHistory(guildId: string): void {
    this.playHistory.delete(guildId);
  }

  /**
   * Get statistics for a guild
   */
  getStats(guildId: string): {
    totalPlays: number;
    uniqueTracks: number;
    averageRepeatInterval: number;
  } {
    const history = this.playHistory.get(guildId);
    if (!history || history.length === 0) {
      return {
        totalPlays: 0,
        uniqueTracks: 0,
        averageRepeatInterval: 0,
      };
    }

    const uniqueUrls = new Set(history.map((entry) => entry.url));
    const urlLastPlayed = new Map<string, number>();
    let totalInterval = 0;
    let intervalCount = 0;

    for (const entry of history) {
      const lastPlayed = urlLastPlayed.get(entry.url);
      if (lastPlayed !== undefined) {
        totalInterval += entry.playedAt - lastPlayed;
        intervalCount++;
      }
      urlLastPlayed.set(entry.url, entry.playedAt);
    }

    return {
      totalPlays: history.length,
      uniqueTracks: uniqueUrls.size,
      averageRepeatInterval:
        intervalCount > 0 ? totalInterval / intervalCount : 0,
    };
  }
}

// Global instance
export const repetitionControl = new RepetitionControl();
