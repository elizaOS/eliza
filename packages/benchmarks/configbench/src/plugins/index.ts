import type { MockPluginDefinition } from "../types.js";

export const ALL_MOCK_PLUGINS: MockPluginDefinition[] = [
  {
    name: "mock-weather",
    requiredSecrets: {
      WEATHER_API_KEY: { required: true },
    },
  },
  {
    name: "mock-payment",
    requiredSecrets: {
      STRIPE_SECRET_KEY: { required: true },
      STRIPE_WEBHOOK_SECRET: { required: true },
    },
  },
  {
    name: "mock-social",
    requiredSecrets: {
      TWITTER_API_KEY: { required: true },
      TWITTER_API_SECRET: { required: true },
    },
  },
  {
    name: "mock-database",
    requiredSecrets: {
      DATABASE_URL: { required: true },
      DATABASE_POOL_SIZE: { required: false },
    },
  },
];

export const PLUGIN_REQUIRED_SECRETS: Record<string, string[]> = Object.fromEntries(
  ALL_MOCK_PLUGINS.map(p => [
    p.name,
    Object.entries(p.requiredSecrets).filter(([_, r]) => r.required).map(([k]) => k),
  ])
);

export function getActivatedPlugins(storedSecrets: Record<string, string>): string[] {
  return Object.entries(PLUGIN_REQUIRED_SECRETS)
    .filter(([_, keys]) => keys.every(k => k in storedSecrets && storedSecrets[k].length > 0))
    .map(([name]) => name);
}

export function getNewlyActivatedPlugin(
  secretsBefore: Record<string, string>,
  secretsAfter: Record<string, string>,
): string | null {
  const before = new Set(getActivatedPlugins(secretsBefore));
  for (const plugin of getActivatedPlugins(secretsAfter)) {
    if (!before.has(plugin)) return plugin;
  }
  return null;
}

export function getNewlyDeactivatedPlugin(
  secretsBefore: Record<string, string>,
  secretsAfter: Record<string, string>,
): string | null {
  const before = new Set(getActivatedPlugins(secretsBefore));
  const after = new Set(getActivatedPlugins(secretsAfter));
  for (const plugin of before) {
    if (!after.has(plugin)) return plugin;
  }
  return null;
}
