import { BaseApiClient } from '../lib/base-client';
import {
  SystemEnvironment,
  LocalEnvironmentUpdateParams,
} from '../types/system';

export class SystemService extends BaseApiClient {
  /**
   * Get environment information
   */
  async getEnvironment(): Promise<SystemEnvironment> {
    return this.get<SystemEnvironment>('/api/system/environment');
  }

  /**
   * Update local environment
   */
  async updateLocalEnvironment(
    params: LocalEnvironmentUpdateParams
  ): Promise<{ updated: number }> {
    return this.post<{ updated: number }>('/api/system/local', params);
  }
}