import type { OAuthConnection, TokenResult } from "../types";

export interface ConnectionAdapter {
  platform: string;
  listConnections(organizationId: string): Promise<OAuthConnection[]>;
  getToken(organizationId: string, connectionId: string): Promise<TokenResult>;
  revoke(organizationId: string, connectionId: string): Promise<void>;
  ownsConnection(connectionId: string): Promise<boolean>;
}
