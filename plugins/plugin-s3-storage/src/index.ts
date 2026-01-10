import type { Plugin } from '@elizaos/core';

import { AwsS3Service } from './services/awsS3';

export const storageS3Plugin: Plugin = {
  name: 'storage-s3',
  description: 'Plugin for storage in S3',
  services: [AwsS3Service],
  actions: [],
};

export default storageS3Plugin;
