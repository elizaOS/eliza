import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { logger } from "@elizaos/core";
import { augmentEnvWithFfmpegTools } from "./ffmpegEnv";
import { formatMusicDebugCommand, musicDebug } from "./musicDebug";
import { getYtdlpPath, YTDLP_INSTALL_INSTRUCTIONS } from "./ytdlpCheck";
import { getYtdlpJsRuntimeCliArgs } from "./ytdlpCli";
import {
  getYoutubeExtractorArgsValue,
  getYtdlpEjsFailureHint,
  isYoutubeStreamUrl,
  YTDLP_STDERR_SNIPPET_LEN,
} from "./ytdlpYoutube";

interface YtdlpStreamError extends NodeJS.ErrnoException {
  ageVerificationDetected?: boolean;
  downloadBlocked?: boolean;
  stderrBuffer?: string[];
}

function annotateYtdlpError(
  error: Error,
  details: Pick<
    YtdlpStreamError,
    "ageVerificationDetected" | "downloadBlocked" | "stderrBuffer"
  > & { code?: number | string | null },
): YtdlpStreamError {
  const annotated = error as YtdlpStreamError;
  annotated.code =
    details.code !== null && details.code !== undefined
      ? String(details.code)
      : undefined;
  annotated.stderrBuffer = details.stderrBuffer;
  annotated.ageVerificationDetected = details.ageVerificationDetected;
  annotated.downloadBlocked = details.downloadBlocked;
  return annotated;
}

function getYtdlpErrorMetadata(error: unknown): Partial<YtdlpStreamError> {
  return error && typeof error === "object"
    ? (error as Partial<YtdlpStreamError>)
    : {};
}

/**
 * Get YouTube cookies file path from environment or return null
 */
function getYouTubeCookiesPath(): string | null {
  // Check environment variable first
  const cookiesPath = process.env.YOUTUBE_COOKIES || process.env.YTDLP_COOKIES;
  if (cookiesPath && existsSync(cookiesPath)) {
    logger.debug(`Using YouTube cookies file: ${cookiesPath}`);
    return cookiesPath;
  }
  return null;
}

/**
 * Get proxy URL from environment or return null
 * Supports HTTP, HTTPS, and SOCKS proxies
 */
function getProxyUrl(): string | null {
  // Check multiple environment variable names for proxy
  const proxyUrl =
    process.env.YOUTUBE_PROXY ||
    process.env.YTDLP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy;

  if (proxyUrl) {
    // Validate proxy URL format
    try {
      const url = new URL(proxyUrl);
      if (["http:", "https:", "socks4:", "socks5:"].includes(url.protocol)) {
        logger.debug(`Using proxy: ${proxyUrl}`);
        return proxyUrl;
      } else {
        logger.warn(
          `Invalid proxy protocol: ${url.protocol}. Supported: http, https, socks4, socks5`,
        );
      }
    } catch (_error) {
      logger.warn(`Invalid proxy URL format: ${proxyUrl}`);
    }
  }
  return null;
}

/**
 * Create a yt-dlp stream with the specified format selector
 *
 * Downloads to a temporary file first (bypasses YouTube stdout streaming restrictions),
 * then streams from that file. The temp file is automatically cleaned up after streaming.
 */
async function createYtdlpStreamWithFormat(
  url: string,
  formatSelector: string,
  ytdlpPath: string,
  cookiesPath: string | null,
  proxyUrl: string | null,
): Promise<{
  stream: Readable;
  stderrBuffer: string[];
  ageVerificationDetected: boolean;
  downloadBlocked: boolean;
}> {
  return new Promise((resolve, reject) => {
    // Generate unique temp file path
    const tempFileName = `ytdlp_${randomBytes(8).toString("hex")}.opus`;
    const tempFilePath = join(tmpdir(), tempFileName);

    logger.debug(`[ytdlp] Downloading to temp file: ${tempFilePath}`);

    // Build yt-dlp command arguments
    const args: string[] = [
      ...getYtdlpJsRuntimeCliArgs(),
      "-f",
      formatSelector,
      "-x", // Extract audio only
      "--audio-format",
      "opus", // Convert to opus (required for Discord voice streaming)
      "--audio-quality",
      "0", // Best quality (VBR)
      "--no-playlist",
    ];

    if (isYoutubeStreamUrl(url)) {
      const extractorArgs = getYoutubeExtractorArgsValue();
      if (extractorArgs) {
        args.push("--extractor-args", extractorArgs);
        logger.debug(`[ytdlp] YouTube extractor-args: ${extractorArgs}`);
      }
    }

    // Add proxy if available
    if (proxyUrl) {
      args.push("--proxy", proxyUrl);
      logger.debug(`[ytdlp] Using proxy: ${proxyUrl}`);
    }

    // Add cookies if available
    if (cookiesPath) {
      args.push("--cookies", cookiesPath);
      logger.debug(
        `[ytdlp] Using cookies file for authentication: ${cookiesPath}`,
      );
    }

    // Download to temp file instead of stdout (bypasses YouTube streaming restrictions)
    args.push("-o", tempFilePath);
    args.push(url);

    const ytdlp = spawn(ytdlpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: augmentEnvWithFfmpegTools(),
    });

    logger.debug(
      `[ytdlp] yt-dlp spawned with format selector: ${formatSelector}, PID: ${ytdlp.pid}`,
    );

    let resolved = false;
    const stderrBuffer: string[] = [];
    let ageVerificationDetected = false;
    let downloadBlocked = false;

    ytdlp.stdout.on("data", (data) => {
      // Log any stdout (usually progress info)
      const msg = data.toString();
      if (msg.includes("[download]")) {
        logger.debug(`[ytdlp] ${msg.trim()}`);
      }
    });

    ytdlp.stderr.on("data", (data) => {
      const msg = data.toString();
      stderrBuffer.push(msg);

      const msgLower = msg.toLowerCase();
      if (
        msgLower.includes("age verification") ||
        msgLower.includes("restricted in your region") ||
        msgLower.includes("sign in to confirm") ||
        msgLower.includes("not a bot")
      ) {
        ageVerificationDetected = true;
      }

      if (
        msg.includes("[download]") &&
        msg.includes("0.0%") &&
        msg.includes("ETA Unknown")
      ) {
        downloadBlocked = true;
      }

      if (msg.includes("[info]")) {
        logger.debug(`[ytdlp] yt-dlp info: ${msg.substring(0, 300)}`);
      }
    });

    ytdlp.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        const stderrText = stderrBuffer.join("").trimEnd();
        musicDebug("ytdlp spawn/process error", {
          url,
          formatSelector,
          command: formatMusicDebugCommand(ytdlpPath, args),
          message: error instanceof Error ? error.message : String(error),
          stderr: stderrText.length > 0 ? stderrText : undefined,
        });
        // Clean up temp file on error
        try {
          if (existsSync(tempFilePath)) {
            unlinkSync(tempFilePath);
          }
        } catch (cleanupError) {
          logger.debug(`[ytdlp] Failed to cleanup temp file: ${cleanupError}`);
        }
        const wrapped =
          error instanceof Error ? error : new Error(String(error));
        (
          wrapped as NodeJS.ErrnoException & { stderrBuffer?: string[] }
        ).stderrBuffer = stderrBuffer;
        reject(wrapped);
      }
    });

    // Use `close` (not `exit`) so stderr/stdout pipes are flushed before we read the result.
    ytdlp.on("close", (code, signal) => {
      if (!resolved) {
        resolved = true;

        if (code === 0) {
          // Download succeeded, check if file exists
          if (!existsSync(tempFilePath)) {
            const stderrText = stderrBuffer.join("").trimEnd();
            musicDebug("ytdlp exit 0 but temp file missing", {
              url,
              formatSelector,
              tempFilePath,
              command: formatMusicDebugCommand(ytdlpPath, args),
              stderr: stderrText.length > 0 ? stderrText : undefined,
            });
            const error = new Error(
              "Download completed but temp file not found",
            );
            reject(
              annotateYtdlpError(error, {
                code,
                stderrBuffer,
                ageVerificationDetected,
                downloadBlocked,
              }),
            );
            return;
          }

          // Create read stream from temp file
          try {
            const fileStream = createReadStream(tempFilePath, {
              highWaterMark: 64 * 1024, // 64KB buffer
            });

            // Create a PassThrough to control the stream lifecycle
            const stream = new PassThrough();
            stream.setMaxListeners(20);

            // Pipe file to output stream
            fileStream.pipe(stream);

            // Clean up temp file when streaming is done or errored
            const cleanup = () => {
              try {
                if (existsSync(tempFilePath)) {
                  unlinkSync(tempFilePath);
                  logger.debug(`[ytdlp] Cleaned up temp file: ${tempFilePath}`);
                }
              } catch (cleanupError) {
                logger.debug(
                  `[ytdlp] Failed to cleanup temp file: ${cleanupError}`,
                );
              }
            };

            stream.on("end", cleanup);
            stream.on("close", cleanup);
            stream.on("error", (error) => {
              logger.error(`[ytdlp] Stream error: ${error}`);
              cleanup();
            });

            // Handle file stream errors
            fileStream.on("error", (error) => {
              logger.error(`[ytdlp] File stream error: ${error}`);
              stream.destroy(error);
            });

            logger.debug(
              `[ytdlp] Successfully created stream from temp file: ${tempFilePath}`,
            );
            musicDebug("ytdlp temp file stream ready", {
              tempFilePath,
              formatSelector,
            });
            resolve({
              stream,
              stderrBuffer,
              ageVerificationDetected,
              downloadBlocked,
            });
          } catch (streamError) {
            // Clean up temp file on stream creation error
            try {
              if (existsSync(tempFilePath)) {
                unlinkSync(tempFilePath);
              }
            } catch (cleanupError) {
              logger.debug(
                `[ytdlp] Failed to cleanup temp file: ${cleanupError}`,
              );
            }
            reject(streamError);
          }
        } else {
          // Clean up temp file
          try {
            if (existsSync(tempFilePath)) {
              unlinkSync(tempFilePath);
            }
          } catch (cleanupError) {
            logger.debug(
              `[ytdlp] Failed to cleanup temp file: ${cleanupError}`,
            );
          }

          const stderrText = stderrBuffer.join("").trim();
          if (stderrText) {
            logger.error(
              `[ytdlp] yt-dlp stderr (exit ${code ?? "null"}, signal ${signal ?? "none"}):\n${stderrText.substring(0, YTDLP_STDERR_SNIPPET_LEN)}`,
            );
          }

          musicDebug("ytdlp exit failure", {
            url,
            formatSelector,
            code: code ?? undefined,
            signal: signal ?? undefined,
            command: formatMusicDebugCommand(ytdlpPath, args),
            stderr: stderrText,
          });

          const msg =
            signal && (code === null || code === undefined)
              ? `yt-dlp terminated by signal ${signal}`
              : `yt-dlp exited with code ${code}`;
          const error = new Error(msg);
          (error as NodeJS.ErrnoException & { stderrBuffer?: string[] }).code =
            code != null ? String(code) : undefined;
          (error as { stderrBuffer?: string[] }).stderrBuffer = stderrBuffer;
          (
            error as { ageVerificationDetected?: boolean }
          ).ageVerificationDetected = ageVerificationDetected;
          (error as { downloadBlocked?: boolean }).downloadBlocked =
            downloadBlocked;
          reject(error);
        }
      }
    });

    // Timeout after 60 seconds (increased from 15s since we're downloading to file)
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const stderrText = stderrBuffer.join("").trimEnd();
        musicDebug("ytdlp timeout", {
          url,
          formatSelector,
          command: formatMusicDebugCommand(ytdlpPath, args),
          stderr: stderrText.length > 0 ? stderrText : undefined,
        });
        ytdlp.kill();
        // Clean up temp file on timeout
        try {
          if (existsSync(tempFilePath)) {
            unlinkSync(tempFilePath);
          }
        } catch (cleanupError) {
          logger.debug(`[ytdlp] Failed to cleanup temp file: ${cleanupError}`);
        }
        reject(new Error("yt-dlp timeout"));
      }
    }, 60000);
  });
}

/**
 * Fallback to yt-dlp when play-dl fails
 * This handles videos that play-dl can't stream (like certain restricted videos)
 *
 * Note: yt-dlp outputs opus format directly, which Discord.js can handle via demuxProbe
 *
 * Uses a retry mechanism: if the preferred format fails, tries with a more permissive format
 */
export async function createYtdlpStream(url: string): Promise<Readable> {
  logger.debug(`Using yt-dlp fallback for: ${url}`);

  // Verify yt-dlp is available before attempting to use it
  let ytdlpPath: string;
  try {
    ytdlpPath = await getYtdlpPath();
    logger.debug(`Using yt-dlp at: ${ytdlpPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`yt-dlp not available: ${errorMessage}`);
    throw new Error(
      `yt-dlp is required for audio playback but was not found.\n${YTDLP_INSTALL_INSTRUCTIONS}`,
    );
  }

  // Check for YouTube cookies for authentication
  const cookiesPath = getYouTubeCookiesPath();

  // Check for proxy configuration
  const proxyUrl = getProxyUrl();

  // Try with preferred format first (opus audio)
  const preferredFormat =
    "bestaudio[ext=webm][acodec*=opus]/bestaudio[acodec*=opus]/bestaudio[ext=webm]/bestaudio";

  try {
    const result = await createYtdlpStreamWithFormat(
      url,
      preferredFormat,
      ytdlpPath,
      cookiesPath,
      proxyUrl,
    );
    logger.debug(`[ytdlp] Successfully created stream with preferred format`);
    return result.stream;
  } catch (error: unknown) {
    const ytdlpError = getYtdlpErrorMetadata(error);
    // Check if this is a format availability issue (not age restriction or region block)
    const stderrOutput = (ytdlpError.stderrBuffer || []).join("").toLowerCase();
    const isFormatNotAvailable =
      stderrOutput.includes("requested format is not available") ||
      stderrOutput.includes("no suitable formats found");
    const isFormatIssue =
      (ytdlpError.code === "0" &&
        !ytdlpError.ageVerificationDetected &&
        !ytdlpError.downloadBlocked) ||
      (isFormatNotAvailable &&
        !ytdlpError.ageVerificationDetected &&
        !ytdlpError.downloadBlocked);

    if (isFormatIssue) {
      logger.info(
        `[ytdlp] Preferred format failed, retrying with any available format...`,
      );

      // Try with permissive format - prefer audio formats, then any video format
      // The -x flag will extract audio from video formats
      // We limit height to reduce bandwidth and ensure faster processing
      const permissiveFormat =
        "bestaudio/best[height<=720]/best[height<=480]/best";

      try {
        const result = await createYtdlpStreamWithFormat(
          url,
          permissiveFormat,
          ytdlpPath,
          cookiesPath,
          proxyUrl,
        );
        logger.warn(
          `[ytdlp] Using permissive format fallback - this may result in lower quality or compatibility issues`,
        );
        logger.info(
          `[ytdlp] Successfully created stream with permissive format`,
        );
        return result.stream;
      } catch (retryError: unknown) {
        const retryYtdlpError = getYtdlpErrorMetadata(retryError);
        // Both attempts failed - provide helpful error message
        const stderrOutput = (retryYtdlpError.stderrBuffer || [])
          .join("")
          .trim();
        const stderrLower = stderrOutput.toLowerCase();

        let helpfulHint = "";
        if (
          retryYtdlpError.ageVerificationDetected ||
          retryYtdlpError.downloadBlocked ||
          stderrLower.includes("age verification") ||
          stderrLower.includes("restricted in your region") ||
          stderrLower.includes("sign in to confirm") ||
          stderrLower.includes("not a bot")
        ) {
          helpfulHint =
            "\n\n⚠️  This video requires age verification, authentication, or is restricted.\n\n" +
            "To fix this:\n" +
            "1. Export your YouTube cookies using a browser extension:\n" +
            '   - Install "Get cookies.txt LOCALLY" or "cookies.txt" extension\n' +
            "   - Export cookies from youtube.com to a file (e.g., youtube_cookies.txt)\n" +
            "   - Set environment variable: export YOUTUBE_COOKIES=/path/to/youtube_cookies.txt\n" +
            "   - Or: export YTDLP_COOKIES=/path/to/youtube_cookies.txt\n\n" +
            "2. Alternatively, use yt-dlp's built-in browser authentication:\n" +
            "   yt-dlp --cookies-from-browser chrome\n" +
            '   (replace "chrome" with your browser: chrome, firefox, edge, safari, etc.)\n\n' +
            "3. If the video is region-restricted, you may need a VPN or proxy:\n" +
            "   export YOUTUBE_PROXY=http://proxy:port";
        } else {
          helpfulHint =
            "\n\nPossible causes:\n" +
            "- Video requires authentication (set YOUTUBE_COOKIES)\n" +
            "- Video requires age verification or is region-restricted\n" +
            "- No suitable format available\n" +
            "- Video is private or restricted";
        }

        helpfulHint += getYtdlpEjsFailureHint(stderrOutput);

        const errorMessage = `yt-dlp failed to extract audio from URL: ${url}${stderrOutput ? `\n\nStderr output:\n${stderrOutput.substring(0, YTDLP_STDERR_SNIPPET_LEN)}` : ""}${helpfulHint}`;
        logger.error(`[ytdlp] ${errorMessage}`);
        throw new Error(errorMessage);
      }
    } else {
      // Complete block (age verification, etc.) - don't retry, just provide helpful message
      const stderrOutput = (ytdlpError.stderrBuffer || []).join("").trim();
      const stderrLower = stderrOutput.toLowerCase();

      // Check if it's a format error that we somehow missed
      const isFormatError =
        stderrLower.includes("requested format is not available") ||
        stderrLower.includes("no suitable formats found");

      let helpfulHint = "";
      if (isFormatError) {
        helpfulHint =
          "\n\nℹ️  The requested audio format is not available for this video.\n" +
          "This can happen with:\n" +
          "- Live streams that haven't started yet\n" +
          "- Videos that are being processed\n" +
          "- Videos with unusual encoding\n" +
          "Try again later or try a different video.";
      } else if (
        ytdlpError.ageVerificationDetected ||
        ytdlpError.downloadBlocked ||
        stderrLower.includes("age verification") ||
        stderrLower.includes("restricted in your region") ||
        stderrLower.includes("sign in to confirm") ||
        stderrLower.includes("not a bot")
      ) {
        helpfulHint =
          "\n\n⚠️  This video requires age verification, authentication, or is restricted.\n\n" +
          "To fix this:\n" +
          "1. Export your YouTube cookies using a browser extension:\n" +
          '   - Install "Get cookies.txt LOCALLY" or "cookies.txt" extension\n' +
          "   - Export cookies from youtube.com to a file (e.g., youtube_cookies.txt)\n" +
          "   - Set environment variable: export YOUTUBE_COOKIES=/path/to/youtube_cookies.txt\n" +
          "   - Or: export YTDLP_COOKIES=/path/to/youtube_cookies.txt\n\n" +
          "2. Alternatively, use yt-dlp's built-in browser authentication:\n" +
          "   yt-dlp --cookies-from-browser chrome\n" +
          '   (replace "chrome" with your browser: chrome, firefox, edge, safari, etc.)\n\n' +
          "3. If the video is region-restricted, you may need a VPN or proxy:\n" +
          "   export YOUTUBE_PROXY=http://proxy:port";
      }

      helpfulHint += getYtdlpEjsFailureHint(stderrOutput);

      const errorMessage = `yt-dlp failed to extract audio from URL: ${url}${stderrOutput ? `\n\nStderr output:\n${stderrOutput.substring(0, YTDLP_STDERR_SNIPPET_LEN)}` : ""}${helpfulHint}`;
      logger.error(`[ytdlp] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
}
