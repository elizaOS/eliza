/**
 * Browser entry point for @elizaos/plugin-s3-storage
 *
 * Note: Full S3 functionality requires Node.js.
 * This module exports types and a limited browser-compatible API.
 */

export * from "./types";

// Re-export plugin definition without Node.js-specific service
import type { Plugin } from "@elizaos/core";

/**
 * S3 Storage Plugin for elizaOS (browser version).
 *
 * Note: File system operations are not available in the browser.
 * Use the Node.js version for full functionality.
 */
export const storageS3Plugin: Plugin = {
  name: "storage-s3",
  description: "Plugin for file storage in AWS S3 (browser version - limited functionality)",
  services: [],
  actions: [],
};

export default storageS3Plugin;

