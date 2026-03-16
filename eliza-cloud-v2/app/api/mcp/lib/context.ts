/**
 * MCP Auth Context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthResult, Organization } from "@/lib/auth";
import type { UserWithOrganization } from "@/lib/types";

export type AuthResultWithOrg = AuthResult & {
  user: UserWithOrganization & {
    organization_id: string;
    organization: Organization;
  };
};

export const authContextStorage = new AsyncLocalStorage<AuthResultWithOrg>();

export function getAuthContext(): AuthResultWithOrg {
  const context = authContextStorage.getStore();
  if (!context) {
    throw new Error("Authentication context not available");
  }
  return context;
}
