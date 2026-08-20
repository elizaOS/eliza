/**
 * Owns Plaid Item credentials and exposes only organization-scoped opaque
 * connection ids to routes. Tokens remain encrypted inside Cloud storage.
 */

import { vendorConnectionsRepository } from "../../db/repositories/vendor-connections";
import type {
  VendorConnection,
  VendorConnectionMetadata,
} from "../../db/schemas/vendor-connections";
import { logger } from "../utils/logger";
import {
  AgentPlaidConnectorError,
  exchangePlaidPublicToken,
  getPlaidEnvironment,
  getPlaidItemInfo,
  type PlaidInstitutionInfo,
  type PlaidTransactionDelta,
  removePlaidItem,
  syncPlaidTransactions,
} from "./agent-plaid-connector";
import { EncryptionKeyMismatchError } from "./secrets/encryption";

const PLAID_VENDOR = "plaid";

type PlaidEnvironment = "sandbox" | "development" | "production";

function isPlaidEnvironment(value: unknown): value is PlaidEnvironment {
  return value === "sandbox" || value === "development" || value === "production";
}

interface PlaidConnectionStore {
  upsertOrgBoundAccessToken(input: {
    organizationId: string;
    vendor: string;
    label: string | null;
    accessToken: string;
    expiresAt: Date | null;
    scopes: string[];
    metadata: VendorConnectionMetadata;
  }): Promise<VendorConnection>;
  findActiveByIdForOrganization(
    id: string,
    organizationId: string,
    vendor: string,
  ): Promise<VendorConnection | null>;
  getOrgBoundAccessToken(connection: VendorConnection): Promise<string>;
  deleteActiveByIdForOrganization(
    id: string,
    organizationId: string,
    vendor: string,
  ): Promise<boolean>;
}

interface PlaidProtocol {
  exchange(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  itemInfo(accessToken: string): Promise<PlaidInstitutionInfo>;
  sync(args: {
    accessToken: string;
    cursor?: string;
    count?: number;
  }): Promise<PlaidTransactionDelta>;
  remove(accessToken: string, environment?: PlaidEnvironment): Promise<void>;
  environment(): PlaidEnvironment;
}

export class PlaidConnectionError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "PlaidConnectionError";
  }
}

const defaultProtocol: PlaidProtocol = {
  exchange: (publicToken) => exchangePlaidPublicToken({ publicToken }),
  itemInfo: (accessToken) => getPlaidItemInfo({ accessToken }),
  sync: (args) => syncPlaidTransactions(args),
  remove: (accessToken, environment) => removePlaidItem({ accessToken, environment }),
  environment: getPlaidEnvironment,
};

export class PlaidConnectionService {
  constructor(
    private readonly store: PlaidConnectionStore = vendorConnectionsRepository,
    private readonly protocol: PlaidProtocol = defaultProtocol,
  ) {}

  async exchange(args: { organizationId: string; publicToken: string }): Promise<{
    connectionId: string;
    institution: PlaidInstitutionInfo;
    environment: PlaidEnvironment;
  }> {
    const environment = this.protocol.environment();
    const exchanged = await this.protocol.exchange(args.publicToken);
    try {
      const institution = await this.protocol.itemInfo(exchanged.accessToken);
      const connection = await this.store.upsertOrgBoundAccessToken({
        organizationId: args.organizationId,
        vendor: PLAID_VENDOR,
        label: exchanged.itemId,
        accessToken: exchanged.accessToken,
        expiresAt: null,
        scopes: ["transactions"],
        metadata: {
          plaid_item_id: exchanged.itemId,
          plaid_environment: environment,
          plaid_institution: institution,
        },
      });
      return { connectionId: connection.id, institution, environment };
    } catch (error) {
      try {
        await this.protocol.remove(exchanged.accessToken);
      } catch (cleanupError) {
        // error-policy:J6 compensating revoke is best-effort; warn without
        // credential material and preserve the authoritative storage failure.
        logger.warn(
          "[PlaidConnectionService] Failed to revoke Item after connection storage failure",
          {
            error: cleanupError instanceof Error ? cleanupError.message : "unknown cleanup failure",
          },
        );
      }
      throw error;
    }
  }

  async sync(args: {
    organizationId: string;
    connectionId: string;
    cursor?: string;
    count?: number;
  }): Promise<PlaidTransactionDelta> {
    const connection = await this.requireConnection(args.organizationId, args.connectionId);
    const accessToken = await this.getAccessToken(connection);
    return this.protocol.sync({
      accessToken,
      cursor: args.cursor,
      count: args.count,
    });
  }

  async revoke(args: { organizationId: string; connectionId: string }): Promise<{ revoked: true }> {
    const connection = await this.store.findActiveByIdForOrganization(
      args.connectionId,
      args.organizationId,
      PLAID_VENDOR,
    );
    if (!connection) {
      return { revoked: true };
    }
    const storedEnvironment = this.requireStoredEnvironment(connection);
    const accessToken = await this.getAccessToken(connection);
    try {
      await this.protocol.remove(accessToken, storedEnvironment);
    } catch (error) {
      if (
        !(error instanceof AgentPlaidConnectorError) ||
        (error.code !== "ITEM_NOT_FOUND" && error.code !== "INVALID_ACCESS_TOKEN")
      ) {
        throw error;
      }
      // error-policy:J1 Plaid already removed the Item; local deletion is the
      // idempotent boundary translation for a retry after partial success.
    }
    await this.store.deleteActiveByIdForOrganization(
      args.connectionId,
      args.organizationId,
      PLAID_VENDOR,
    );
    return { revoked: true };
  }

  private async requireConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<VendorConnection> {
    const connection = await this.store.findActiveByIdForOrganization(
      connectionId,
      organizationId,
      PLAID_VENDOR,
    );
    if (!connection) {
      throw new PlaidConnectionError(404, "Plaid connection not found.");
    }
    this.requireCurrentEnvironment(connection);
    return connection;
  }

  private requireCurrentEnvironment(connection: VendorConnection): void {
    const storedEnvironment = this.requireStoredEnvironment(connection);
    if (storedEnvironment !== this.protocol.environment()) {
      throw new PlaidConnectionError(
        409,
        "This Plaid connection belongs to a different environment. Re-link the account.",
      );
    }
  }

  private requireStoredEnvironment(connection: VendorConnection): PlaidEnvironment {
    const storedEnvironment = connection.connection_metadata.plaid_environment;
    if (
      connection.connection_metadata.encryption_context !== "org_bound_v1" ||
      !isPlaidEnvironment(storedEnvironment)
    ) {
      throw new PlaidConnectionError(
        409,
        "This Plaid connection has legacy or invalid Cloud credential metadata. Re-link the account.",
      );
    }
    return storedEnvironment;
  }

  private async getAccessToken(connection: VendorConnection): Promise<string> {
    try {
      return await this.store.getOrgBoundAccessToken(connection);
    } catch (error) {
      // error-policy:J1 translate an expected at-rest key transition into the
      // public recovery contract without exposing key identifiers.
      if (error instanceof EncryptionKeyMismatchError) {
        throw new PlaidConnectionError(
          409,
          "This Plaid connection requires credential rotation or re-linking.",
        );
      }
      throw error;
    }
  }
}

export const plaidConnectionService = new PlaidConnectionService();
