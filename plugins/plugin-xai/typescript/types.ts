/**
 * Type definitions for plugin-xai
 */

export type XServiceStatus = 'idle' | 'active' | 'error';

export interface XClientConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}
