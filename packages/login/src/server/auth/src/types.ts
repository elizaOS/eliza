import type { Tenant } from "../../db/src/index.ts";

export interface AuthContext {
  tenantId: string;
  tenant: Tenant;
}

export interface ApiKeyPair {
  key: string;
  hash: string;
}

export type AuthVariables = AuthContext;
