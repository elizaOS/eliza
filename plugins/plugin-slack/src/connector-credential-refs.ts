/**
 * Compatibility export for the Core-owned durable connector credential write
 * protocol used by Slack's OAuth callback.
 */
export type {
  ConnectorCredentialPersistResult,
  ConnectorCredentialRefMetadata,
} from "@elizaos/core";
export { persistConnectorCredentialRefs } from "@elizaos/core";
