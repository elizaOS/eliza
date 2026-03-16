import type { Plugin } from "@elizaos/core";
import { AwsS3Service } from "./services/s3.js";

export * from "./services";
export * from "./types";

export const storageS3Plugin: Plugin = {
  name: "storage-s3",
  description: "Plugin for file storage in AWS S3 and S3-compatible services",
  services: [AwsS3Service],
  actions: [],
};

export default storageS3Plugin;
