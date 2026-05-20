/**
 * User Core Plugin Types
 */

/**
 * Parameters for CHECK_MARKETS action
 */
export interface CheckMarketsParams {
  /** Type of markets to check: "predictions", "perps", or "all" */
  type?: "predictions" | "perps" | "all";
  /** Maximum number of markets to return per type */
  limit?: number;
}
