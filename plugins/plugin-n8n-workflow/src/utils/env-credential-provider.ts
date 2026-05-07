/**
 * Base helper for connector plugins that supply n8n credentials from env vars.
 *
 * Each connector plugin creates a provider instance specifying which env vars
 * map to which n8n credential type, then registers it on the runtime as
 * N8N_CREDENTIAL_PROVIDER_TYPE. The plugin-n8n-workflow resolution chain
 * calls resolve() and handles credential creation + caching automatically.
 */

import type { CredentialProvider, CredentialProviderResult, CheckCredentialTypesResult } from '../types/index';

export interface EnvCredentialMapping {
  /** n8n credential type name, e.g. 'slackApi' */
  credType: string;
  /** Function that reads env vars and returns the n8n credential data object, or null if not configured */
  getData: () => Record<string, unknown> | null;
}

export class EnvCredentialProvider implements CredentialProvider {
  private readonly mappings: EnvCredentialMapping[];

  constructor(mappings: EnvCredentialMapping[]) {
    this.mappings = mappings;
  }

  async resolve(_userId: string, credType: string): Promise<CredentialProviderResult> {
    const mapping = this.mappings.find((m) => m.credType === credType);
    if (!mapping) return null;
    const data = mapping.getData();
    if (!data) return null;
    return { status: 'credential_data', data };
  }

  checkCredentialTypes(credTypes: string[]): CheckCredentialTypesResult {
    const supported = new Set(this.mappings.map((m) => m.credType));
    return {
      supported: credTypes.filter((t) => supported.has(t)),
      unsupported: credTypes.filter((t) => !supported.has(t)),
    };
  }
}
