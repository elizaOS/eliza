import { exec } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

const execAsync = promisify(exec);

export interface StoredTrack {
  url: string;
  title: string;
  artist?: string;
  album?: string;
  filePath: string;
  format: string; // Original format (e.g., 'webm', 'mp4', 'opus')
  size: number;
  duration?: number;
  bitrate?: number;
  storedAt: number;
}

/**
 * Music Storage Service
 * Stores high-quality original music files for archival and library purposes
 *
 * Unlike the Discord-optimized cache in music-player, this stores:
 * - Original quality files (no transcoding)
 * - Permanent storage (not temporary cache)
 * - Organized by artist/album/track
 * - Indexed for library browsing
 */
export class MusicStorageService {
  private storageDir: string;
  private highQuality: boolean; // Store highest quality available
  private index: Map<string, StoredTrack> = new Map(); // key: url
  private readonly INDEX_FILE = "storage_index.json";

  constructor(storageDir?: string, highQuality: boolean = true) {
    this.storageDir = storageDir || join(process.cwd(), "storage", "music");
    this.highQuality = highQuality;

    // Ensure storage directory exists
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
      logger.info(`Created music storage directory: ${this.storageDir}`);
    }

    // Load existing index
    this.loadIndex();
  }

  /**
   * Check if a track is stored
   */
  isStored(url: string): boolean {
    const track = this.index.get(url);
    return track ? existsSync(track.filePath) : false;
  }

  /**
   * Get stored track info
   */
  getStoredTrack(url: string): StoredTrack | null {
    const track = this.index.get(url);
    if (!track || !existsSync(track.filePath)) {
      return null;
    }
    return track;
  }

  /**
   * Get all stored tracks
   */
  getAllTracks(): StoredTrack[] {
    return Array.from(this.index.values()).filter((track) =>
      existsSync(track.filePath),
    );
  }

  /**
   * Store a track from YouTube URL
   */
  async storeTrack(
    url: string,
    metadata: {
      title: string;
      artist?: string;
      album?: string;
    },
  ): Promise<StoredTrack> {
    // Check if already stored
    if (this.isStored(url)) {
      const existing = this.getStoredTrack(url);
      if (existing) {
        logger.debug(`Track already stored: ${metadata.title}`);
        return existing;
      }
    }

    logger.info(`Storing track: ${metadata.title}`);

    // Generate storage path
    const sanitize = (str: string) =>
      str.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 100);
    const artist = sanitize(metadata.artist || "Unknown");
    const album = sanitize(metadata.album || "Unknown");
    const title = sanitize(metadata.title);

    const trackDir = join(this.storageDir, artist, album);
    if (!existsSync(trackDir)) {
      mkdirSync(trackDir, { recursive: true });
    }

    const filePath = join(trackDir, `${title}.webm`);

    // Download using yt-dlp
    try {
      const quality = this.highQuality ? "bestaudio" : "worstaudio";
      const command = `yt-dlp -f "${quality}" --no-playlist -o "${filePath}" "${url}"`;

      logger.debug(`Downloading: ${command}`);
      await execAsync(command, { timeout: 300000 }); // 5 minute timeout

      // Get file info
      const stats = statSync(filePath);
      const metadata_cmd = `ffprobe -v quiet -print_format json -show_format "${filePath}"`;
      const { stdout } = await execAsync(metadata_cmd);
      const info = JSON.parse(stdout);

      const storedTrack: StoredTrack = {
        url,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        filePath,
        format: info.format?.format_name || "webm",
        size: stats.size,
        duration: parseFloat(info.format?.duration) || undefined,
        bitrate: parseInt(info.format?.bit_rate, 10) || undefined,
        storedAt: Date.now(),
      };

      // Add to index
      this.index.set(url, storedTrack);
      this.saveIndex();

      logger.info(
        `Stored track: ${metadata.title} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`,
      );
      return storedTrack;
    } catch (error) {
      logger.error(`Error storing track ${metadata.title}: ${error}`);
      // Clean up partial file
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
      throw error;
    }
  }

  /**
   * Get a readable stream for a stored track
   */
  getStream(url: string): Readable | null {
    const track = this.getStoredTrack(url);
    if (!track) {
      return null;
    }

    return createReadStream(track.filePath);
  }

  /**
   * Delete a stored track
   */
  deleteTrack(url: string): boolean {
    const track = this.index.get(url);
    if (!track) {
      return false;
    }

    try {
      if (existsSync(track.filePath)) {
        unlinkSync(track.filePath);
      }
      this.index.delete(url);
      this.saveIndex();
      logger.info(`Deleted stored track: ${track.title}`);
      return true;
    } catch (error) {
      logger.error(`Error deleting track: ${error}`);
      return false;
    }
  }

  /**
   * Get total storage size in bytes
   */
  getTotalSize(): number {
    let total = 0;
    for (const track of this.index.values()) {
      if (existsSync(track.filePath)) {
        total += track.size;
      }
    }
    return total;
  }

  /**
   * Get storage statistics
   */
  getStats(): {
    totalTracks: number;
    totalSize: number;
    totalDuration: number;
    byArtist: Map<string, number>;
  } {
    const tracks = this.getAllTracks();
    const byArtist = new Map<string, number>();

    let totalSize = 0;
    let totalDuration = 0;

    for (const track of tracks) {
      totalSize += track.size;
      totalDuration += track.duration || 0;

      const artist = track.artist || "Unknown";
      byArtist.set(artist, (byArtist.get(artist) || 0) + 1);
    }

    return {
      totalTracks: tracks.length,
      totalSize,
      totalDuration,
      byArtist,
    };
  }

  /**
   * Load index from disk
   */
  private loadIndex(): void {
    const indexPath = join(this.storageDir, this.INDEX_FILE);
    if (!existsSync(indexPath)) {
      return;
    }

    try {
      const data = readFileSync(indexPath, "utf8");
      const entries = JSON.parse(data);
      this.index = new Map(Object.entries(entries));
      logger.debug(`Loaded ${this.index.size} tracks from storage index`);
    } catch (error) {
      logger.error(`Error loading storage index: ${error}`);
    }
  }

  /**
   * Save index to disk
   */
  private saveIndex(): void {
    const indexPath = join(this.storageDir, this.INDEX_FILE);
    try {
      const entries = Object.fromEntries(this.index);
      const data = JSON.stringify(entries, null, 2);
      writeFileSync(indexPath, data, "utf8");
    } catch (error) {
      logger.error(`Error saving storage index: ${error}`);
    }
  }
}
