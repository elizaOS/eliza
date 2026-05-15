type ConfigRecord = Record<string, unknown> & {
  connectors?: Record<string, unknown>;
};

type SignalConnectorConfig = Record<string, unknown> & {
  authDir?: string;
  account?: string;
  enabled?: boolean;
};

function readSignalConfig(config: ConfigRecord): SignalConnectorConfig | null {
  const raw = config.connectors?.signal;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as SignalConnectorConfig;
}

export function upsertSignalConnectorConfig(
  config: ConfigRecord,
  args: {
    authDir: string;
    account: string;
  },
): boolean {
  const current = readSignalConfig(config);
  const next: SignalConnectorConfig = {
    ...(current ?? {}),
    authDir: args.authDir,
    account: args.account,
    enabled: true,
  };

  const changed =
    !current ||
    current.authDir !== next.authDir ||
    current.account !== next.account ||
    current.enabled !== true;

  if (!changed) {
    return false;
  }

  if (!config.connectors) {
    config.connectors = {};
  }
  config.connectors.signal = next;
  return true;
}

export function removeSignalConnectorConfig(
  config: ConfigRecord,
  args: {
    authDir?: string | null;
    account?: string | null;
  } = {},
): boolean {
  const current = readSignalConfig(config);
  if (!current) {
    return false;
  }

  if (args.authDir && current.authDir && current.authDir !== args.authDir) {
    return false;
  }

  if (args.account && current.account && current.account !== args.account) {
    return false;
  }

  delete config.connectors?.signal;
  return true;
}
