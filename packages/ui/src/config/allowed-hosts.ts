/**
 * Re-exports the shared allowed-host parsing/conversion helpers (Vite + Capacitor
 * allow-navigation).
 */
export {
  type AllowedHostPattern,
  parseAllowedHostEnv,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
} from "@elizaos/shared";
