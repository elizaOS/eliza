/**
 * Transform local file paths to API URLs for web clients
 */

import path from 'node:path';
import { getGeneratedDir, getUploadsAgentsDir, getUploadsChannelsDir } from '@elizaos/core';
import type {
  AttachmentInput,
  MessageWithAttachments,
  MessageContentWithAttachments,
} from '../types';

// Path configurations mapping
// Pattern matches any ID format (not just UUIDs) to support all valid IDs
// The pattern captures the ID (first path segment) and filename (second path segment)
const ID_PATTERN = /^([^/\\]+)[/\\]([^/\\]+)$/;

const PATH_CONFIGS = [
  {
    getPath: getGeneratedDir,
    apiPrefix: '/media/generated/',
    pattern: ID_PATTERN,
  },
  {
    getPath: getUploadsAgentsDir,
    apiPrefix: '/media/uploads/agents/',
    pattern: ID_PATTERN,
  },
  {
    getPath: getUploadsChannelsDir,
    apiPrefix: '/media/uploads/channels/',
    pattern: ID_PATTERN,
  },
];

// Check if path is an external URL (http, https, blob, data, file, ipfs, s3, gs, etc.)
const isExternalUrl = (p: string) => /^(?:https?:|blob:|data:|file:|ipfs:|s3:|gs:)/i.test(p);

/**
 * Transform a local file path to an API URL
 */
export function transformPathToApiUrl(filePath: string): string {
  // Skip if already transformed or not a local absolute path
  if (
    !filePath ||
    isExternalUrl(filePath) ||
    filePath.startsWith('/media/') ||
    !path.isAbsolute(filePath)
  ) {
    return filePath;
  }

  // Normalize path for comparison
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Check each path configuration
  for (const config of PATH_CONFIGS) {
    const configPathRaw = config.getPath().replace(/\\/g, '/');
    const configPath = configPathRaw.endsWith('/') ? configPathRaw : `${configPathRaw}/`;

    // Use strict boundary-aware startsWith check to prevent path traversal
    if (normalizedPath === configPathRaw || normalizedPath.startsWith(configPath)) {
      const relative =
        normalizedPath === configPathRaw ? '' : normalizedPath.slice(configPath.length);

      // Only process if we have a valid relative path
      if (relative) {
        const match = relative.match(config.pattern);
        if (match) {
          const [, id, filename] = match;
          return `${config.apiPrefix}${encodeURIComponent(id)}${'/'}${encodeURIComponent(filename)}`;
        }
      }
    }
  }

  return filePath;
}

/**
 * Convert local file paths to API URLs for attachments
 */
export function attachmentsToApiUrls(attachments: AttachmentInput): AttachmentInput {
  if (!attachments) return attachments;

  if (Array.isArray(attachments)) {
    return attachments.map((attachment) => {
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
export function transformMessageAttachments(
  message: MessageWithAttachments
): MessageWithAttachments {
  if (!message || typeof message !== 'object') {
    return message;
  }

  // Transform attachments in content
  if (message.content && typeof message.content === 'object' && 'attachments' in message.content) {
    const content = message.content as MessageContentWithAttachments;
    if (content.attachments) {
      content.attachments = attachmentsToApiUrls(content.attachments);
    }
  }

  // Transform attachments in metadata
  if (message.metadata?.attachments) {
    message.metadata.attachments = attachmentsToApiUrls(message.metadata.attachments);
  }

  return message;
}
