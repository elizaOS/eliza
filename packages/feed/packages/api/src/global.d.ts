/**
 * Global Type Declarations
 *
 * Extends the Window interface with auth globals.
 */

declare global {
  interface Window {
    /** Returns a fresh access token, automatically refreshing if needed. */
    __getAccessToken?: () => Promise<string | null>;
  }
}

export {};
