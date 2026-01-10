/**
 * @elizaos/plugin-s3-storage
 *
 * AWS S3 Storage Plugin for elizaOS.
 * Provides file upload and download functionality using AWS S3.
 */

import type { Plugin } from "@elizaos/core";
import { AwsS3Service } from "./services/s3";

export * from "./types";
export * from "./services";

/**
 * S3 Storage Plugin for elizaOS.
 */
export const storageS3Plugin: Plugin = {
  name: "storage-s3",
  description: "Plugin for file storage in AWS S3 and S3-compatible services",
  services: [AwsS3Service],
  actions: [],
};

export default storageS3Plugin;

