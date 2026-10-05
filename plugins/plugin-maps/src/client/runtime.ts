import {
  configuredProvider,
  type MapsProvider,
  type ProviderConfig,
} from "./contracts.ts";

/** Trusted connection composition only. No localStorage endpoint/key discovery. */
let connection: { config: ProviderConfig; provider?: MapsProvider } = {
  config: { status: "unconfigured" },
};
const listeners = new Set<() => void>();
export function mapsConnection() {
  return {
    config: structuredClone(connection.config),
    provider: connection.provider,
  };
}
export function configureMapsProvider(
  config: ProviderConfig,
  provider?: MapsProvider,
) {
  if (config.status === "configured") configuredProvider(config, provider);
  connection = {
    config: structuredClone(config),
    provider: config.status === "configured" ? provider : undefined,
  };
  listeners.forEach((listener) => listener());
}
export function onMapsConnectionChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
