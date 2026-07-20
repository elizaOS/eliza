import { InvestigationCase } from "./types";

/**
 * Identifies the individual investor who owns a saved investigation.
 *
 * Later, this value will come from the authenticated SkunkScanAI user.
 */
export type InvestigationOwnerId = string;

/**
 * A saved investigation belonging to an individual investor.
 */
export interface StoredInvestigation {
  ownerId: InvestigationOwnerId;

  investigation: InvestigationCase;

  savedAt: string;

  lastViewedAt?: string;

  /**
   * Investor-selected label shown in saved investigations and watchlists.
   *
   * Examples:
   * - "My main wallet"
   * - "Wallet from Telegram"
   * - "Potential whale"
   */
  personalLabel?: string;

  /**
   * Optional personal notes written by the investor.
   */
  personalNotes?: string;

  /**
   * Indicates whether the investor is actively watching this wallet.
   */
  isWatchlisted: boolean;
}

/**
 * Lightweight information used when displaying an investor's
 * saved investigation history.
 */
export interface StoredInvestigationSummary {
  investigationId: string;

  ownerId: InvestigationOwnerId;

  title: string;

  chain: string;

  address: string;

  status: InvestigationCase["status"];

  createdAt: string;

  updatedAt: string;

  savedAt: string;

  lastRunAt?: string;

  personalLabel?: string;

  isWatchlisted: boolean;
}

/**
 * Input used when an investor saves an investigation.
 */
export interface SaveInvestigationInput {
  ownerId: InvestigationOwnerId;

  investigation: InvestigationCase;

  personalLabel?: string;

  personalNotes?: string;

  isWatchlisted?: boolean;
}

/**
 * Storage contract for individual-investor investigations.
 *
 * The implementation can later use PostgreSQL, Supabase or another
 * persistent database without changing the Investigation Engine.
 */
export interface InvestigationRepository {
  save(
    input: SaveInvestigationInput,
  ): Promise<StoredInvestigation>;

  findById(
    ownerId: InvestigationOwnerId,
    investigationId: string,
  ): Promise<StoredInvestigation | null>;

  listByOwner(
    ownerId: InvestigationOwnerId,
  ): Promise<StoredInvestigationSummary[]>;

  updatePersonalDetails(
    ownerId: InvestigationOwnerId,
    investigationId: string,
    updates: {
      personalLabel?: string;
      personalNotes?: string;
      isWatchlisted?: boolean;
    },
  ): Promise<StoredInvestigation | null>;

  delete(
    ownerId: InvestigationOwnerId,
    investigationId: string,
  ): Promise<boolean>;
}
