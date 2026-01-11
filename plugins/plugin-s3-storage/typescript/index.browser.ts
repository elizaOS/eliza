/**
 * Browser entry point for @elizaos/plugin-s3-storage.
 * Full S3 functionality requires Node.js - exports types and limited browser-compatible API.
 */

// Plugin definition without Node.js-specific service
import type { Plugin } from "@elizaos/core";

/**
 * S3 Storage Plugin for elizaOS (browser version).
 * File system operations unavailable - use Node.js version for full functionality.
 */
export const storageS3Plugin: Plugin = {
  name: "storage-s3",
  description: "Plugin for file storage in AWS S3 (browser version - limited functionality)",
  services: [],
  actions: [],
};

export default storageS3Plugin;
