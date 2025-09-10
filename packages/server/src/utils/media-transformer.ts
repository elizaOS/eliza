/**
 * Transform local file paths to API URLs for web clients
 */

import { getGeneratedDir, getUploadsAgentsDir, getUploadsChannelsDir } from '@elizaos/core';

// Path configurations mapping
// Pattern matches UUID format (8-4-4-4-12 hex digits with hyphens) for agent/channel IDs
// This ensures we only match valid UUIDs for security
const UUID_PATTERN = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[\/\\]([^\/\\]+)$/;

const PATH_CONFIGS = [
  { 
    getPath: getGeneratedDir,
    apiPrefix: '/media/generated/',
    pattern: UUID_PATTERN
  },
  { 
    getPath: getUploadsAgentsDir,
    apiPrefix: '/media/uploads/agents/',
    pattern: UUID_PATTERN
  },
  { 
    getPath: getUploadsChannelsDir,
    apiPrefix: '/media/uploads/channels/',
    pattern: UUID_PATTERN
  }
];

// Regex to detect absolute paths: POSIX (/), Windows (C:\), UNC (\\server\)
const ABSOLUTE_PATH_RE = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/;

// Check if path is an external URL (http, https, blob, data, file, ipfs, s3, gs, etc.)
const isExternalUrl = (p: string) =>
  /^(?:https?:|blob:|data:|file:|ipfs:|s3:|gs:)/i.test(p);

/**
 * Transform a local file path to an API URL
 */
export function transformPathToApiUrl(filePath: string): string {
  // Skip if already transformed or not a local absolute path
  if (!filePath ||
      isExternalUrl(filePath) ||
      filePath.startsWith('/media/') ||
      !ABSOLUTE_PATH_RE.test(filePath)) {
    return filePath;
  }

  // Normalize path for comparison
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Check each path configuration
  for (const config of PATH_CONFIGS) {
    const configPathRaw = config.getPath().replace(/\\/g, '/');
    const configPath = configPathRaw.endsWith('/') ? configPathRaw : configPathRaw + '/';
    
    if (normalizedPath.startsWith(configPath)) {
      const relative = normalizedPath.slice(configPath.length);
      const match = relative.match(config.pattern);

      if (match) {
        const [, id, filename] = match;
        return `${config.apiPrefix}${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
      }
    }
  }

  return filePath;
}

/**
 * Convert local file paths to API URLs for attachments
 */
export function attachmentsToApiUrls(attachments: any): any {
  if (!attachments) return attachments;
  
  if (Array.isArray(attachments)) {
    return attachments.map(attachment => {
      if (typeof attachment === 'string') {
        return transformPathToApiUrl(attachment);
      }
      if (attachment?.url) {
        return { ...attachment, url: transformPathToApiUrl(attachment.url) };
      }
      return attachment;
    });
  }
  
  // Single attachment
  if (typeof attachments === 'string') {
    return transformPathToApiUrl(attachments);
  }
  if (attachments?.url) {
    return { ...attachments, url: transformPathToApiUrl(attachments.url) };
  }
  return attachments;
}

/**
 * Transform attachments in message content and metadata to API URLs
 */
export function transformMessageAttachments(message: any): any {
  if (!message || typeof message !== 'object') {
    return message;
  }

  // Transform attachments in content
  if (message.content && typeof message.content === 'object' && message.content.attachments) {
    message.content.attachments = attachmentsToApiUrls(message.content.attachments);
  }

  // Transform attachments in metadata
  if (message.metadata && message.metadata.attachments) {
    message.metadata.attachments = attachmentsToApiUrls(message.metadata.attachments);
  }

  return message;
}