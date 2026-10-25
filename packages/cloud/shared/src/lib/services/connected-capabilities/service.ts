/**
 * Org-scoped connected-capability projection service, storage-agnostic half.
 * The service consumes an injected source loader so tests and alternative
 * hosts can exercise the real projection and paging logic without a database;
 * the DB-backed loader and process singleton live in `./index.ts`.
 *
 * All reads are scoped by the caller-authenticated organization ID: account
 * handles are only ever searched within the requesting organization's own
 * projection, so a handle minted for another organization cannot resolve.
 */

import type { ConnectedAccount, ConnectedAccountMode } from "@elizaos/core";
import { type ConnectedCapabilitySourceRows, projectConnectedAccounts } from "./projection";

export type { ConnectedAccount, ConnectedAccountMode } from "@elizaos/core";
export { CONNECTED_ACCOUNT_MODES } from "@elizaos/core";
export type {
  ConnectedCapabilitySourceRows,
  DiscordConnectionRow,
  PhoneGatewayDeviceRow,
  PlatformCredentialRow,
  VendorConnectionRow,
} from "./projection";
export { projectConnectedAccounts } from "./projection";

/** Loads one organization's raw connection rows from every projected source. */
export interface ConnectedCapabilitySourceLoader {
  load(organizationId: string): Promise<ConnectedCapabilitySourceRows>;
}

export interface ListConnectedAccountsParams {
  organizationId: string;
  limit: number;
  offset: number;
  providerId?: string;
  mode?: ConnectedAccountMode;
}

export interface ConnectedAccountPage {
  accounts: ConnectedAccount[];
  total: number;
  limit: number;
  offset: number;
}

export class ConnectedCapabilitiesService {
  constructor(
    private readonly loader: ConnectedCapabilitySourceLoader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async project(organizationId: string): Promise<ConnectedAccount[]> {
    let rows: ConnectedCapabilitySourceRows;
    try {
      rows = await this.loader.load(organizationId);
    } catch (error) {
      // error-policy:J2 fail closed — a partial source read would project a
      // silently incomplete account list that reads as "not connected".
      throw new Error(
        `[ConnectedCapabilitiesService] Failed to load connection sources for organization ${organizationId}`,
        { cause: error },
      );
    }
    return projectConnectedAccounts(rows, this.now());
  }

  /** List the organization's connected accounts with deterministic paging. */
  async list(params: ListConnectedAccountsParams): Promise<ConnectedAccountPage> {
    const accounts = await this.project(params.organizationId);
    const filtered = accounts.filter(
      (account) =>
        (params.providerId === undefined || account.providerId === params.providerId) &&
        (params.mode === undefined || account.mode === params.mode),
    );
    return {
      accounts: filtered.slice(params.offset, params.offset + params.limit),
      total: filtered.length,
      limit: params.limit,
      offset: params.offset,
    };
  }

  /** Resolve one account handle inside the organization; null when absent. */
  async get(organizationId: string, accountId: string): Promise<ConnectedAccount | null> {
    const accounts = await this.project(organizationId);
    return accounts.find((account) => account.accountId === accountId) ?? null;
  }
}
