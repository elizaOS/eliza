/**
 * Transform local file paths to API URLs for web clients
 */

import { getGeneratedDir, getUploadsAgentsDir, getUploadsChannelsDir } from '@elizaos/core';

// Path configurations mapping
// Pattern matches UUID format (8-4-4-4-12 hex digits with hyphens) for agent/channel IDs
// This ensures we only match valid UUIDs for security
const UUID_PATTERN = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[\/\\]([^\/\\]+)$/;

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

/**
 * Transform a local file path to an API URL
 */
export function transformPathToApiUrl(filePath: string): string {
  // Skip if already transformed or not a local path
  if (!filePath || 
      filePath.startsWith('http') || 
      filePath.startsWith('/media/') ||
      !filePath.startsWith('/')) {
    return filePath;
  }

  // Normalize path for comparison
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Check each path configuration
  for (const config of PATH_CONFIGS) {
    const configPath = config.getPath().replace(/\\/g, '/');
    
    if (normalizedPath.includes(configPath)) {
      const match = normalizedPath.match(config.pattern);
      if (match) {
        const [, id, filename] = match;
        return `${config.apiPrefix}${id}/${filename}`;
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