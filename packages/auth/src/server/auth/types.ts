import type { Tenant } from "../db/index.ts";

export interface AuthContext {
  tenantId: string;
  tenant: Tenant;
}

export interface ApiKeyPair {
  key: string;
  hash: string;
}

export type AuthVariables = AuthContext;
