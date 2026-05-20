/**
 * Global Type Declarations
 *
 * Extends the Window interface with Privy-specific globals
 */

declare global {
  interface Window {
    /**
     * Privy access token getter - injected by Privy Provider
     * Returns a fresh access token, automatically refreshing if needed
     */
    __privyGetAccessToken?: () => Promise<string | null>;
  }
}

export {};
