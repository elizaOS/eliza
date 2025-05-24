/**
 * Utility functions for parsing and handling media URLs in chat messages
 */

export interface MediaInfo {
  url: string;
  type: 'image' | 'video' | 'unknown';
  isEmbed: boolean;
}

// Common image extensions
const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'tiff',
  'avif',
]);

// Common video extensions
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v', 'ogv']);

// Video platforms that support embedding
const VIDEO_PLATFORMS = {
  youtube: {
    patterns: [
      /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    ],
    getEmbedUrl: (id: string) => `https://www.youtube.com/embed/${id}`,
  },
  vimeo: {
    patterns: [/(?:https?:\/\/)?(?:www\.)?vimeo\.com\/(\d+)/],
    getEmbedUrl: (id: string) => `https://player.vimeo.com/video/${id}`,
  },
};

/**
 * Extracts the file extension from a URL
 */
function getFileExtension(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const extension = pathname.split('.').pop()?.toLowerCase();
    return extension || '';
  } catch {
    return '';
  }
}

/**
 * Checks if a URL points to an image
 */
export function isImageUrl(url: string): boolean {
  const extension = getFileExtension(url);
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Checks if a URL points to a video file
 */
export function isVideoFileUrl(url: string): boolean {
  const extension = getFileExtension(url);
  return VIDEO_EXTENSIONS.has(extension);
}

/**
 * Checks if a URL is from a supported video platform
 */
export function getVideoPlatformInfo(
  url: string
): { platform: string; id: string; embedUrl: string } | null {
  for (const [platform, config] of Object.entries(VIDEO_PLATFORMS)) {
    for (const pattern of config.patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return {
          platform,
          id: match[1],
          embedUrl: config.getEmbedUrl(match[1]),
        };
      }
    }
  }
  return null;
}

/**
 * Parses URLs from text and identifies media types
 */
export function parseMediaFromText(text: string): MediaInfo[] {
  if (!text) return [];

  // Regular expression to find URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex) || [];

  return urls
    .map((url) => {
      // Remove trailing punctuation that might be captured
      const cleanUrl = url.replace(/[.,!?;)]*$/, '');

      if (isImageUrl(cleanUrl)) {
        return {
          url: cleanUrl,
          type: 'image' as const,
          isEmbed: false,
        };
      }

      if (isVideoFileUrl(cleanUrl)) {
        return {
          url: cleanUrl,
          type: 'video' as const,
          isEmbed: false,
        };
      }

      const platformInfo = getVideoPlatformInfo(cleanUrl);
      if (platformInfo) {
        return {
          url: platformInfo.embedUrl,
          type: 'video' as const,
          isEmbed: true,
        };
      }

      return {
        url: cleanUrl,
        type: 'unknown' as const,
        isEmbed: false,
      };
    })
    .filter((media) => media.type !== 'unknown');
}

/**
 * Removes media URLs from text to avoid duplication in display
 */
export function removeMediaUrlsFromText(text: string, mediaInfos: MediaInfo[]): string {
  let cleanText = text;

  mediaInfos.forEach((media) => {
    // For embedded videos, remove the original URL, not the embed URL
    if (media.isEmbed) {
      // Find the original URL that matches this embed
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = text.match(urlRegex) || [];

      for (const url of urls) {
        const cleanUrl = url.replace(/[.,!?;)]*$/, '');
        const platformInfo = getVideoPlatformInfo(cleanUrl);
        if (platformInfo && platformInfo.embedUrl === media.url) {
          cleanText = cleanText.replace(url, '').trim();
          break;
        }
      }
    } else {
      cleanText = cleanText.replace(media.url, '').trim();
    }
  });

  return cleanText;
}
