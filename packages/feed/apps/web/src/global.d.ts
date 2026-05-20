export {};

// TODO: Phase 3 — rename __privyAccessToken / __privyGetAccessToken to
// __accessToken / __getAccessToken once all consumers have migrated off
// the legacy Privy naming.
declare global {
  interface Window {
    __privyAccessToken?: string | null;
    __privyGetAccessToken?: () => Promise<string | null>;
  }
}
