// CYCLE BREAK: previously imported CONNECTOR_IDS from `@elizaos/agent`,
// creating an agent ↔ shared ESM cycle that broke node module resolution
// at bench-server boot. Inline the upstream id list so shared has its
// own canonical copy. Keep in sync with `packages/agent/src/config/schema.ts`
// when new connectors are added there.
const _upstreamConnectorIds = [
  "bluebubbles",
  "telegram",
  "telegramAccount",
  "discord",
  "discordLocal",
  "slack",
  "twitter",
  "whatsapp",
  "signal",
  "imessage",
  "farcaster",
  "lens",
  "msteams",
  "feishu",
] as const;

const ELIZA_COMPAT_CONNECTOR_IDS = ["telegramAccount"] as const;
/** App-local connectors not present in upstream @elizaos/agent. */
export const ELIZA_LOCAL_CONNECTOR_IDS = ["wechat"] as const;

export const CONNECTOR_IDS = Array.from(
  new Set([
    ..._upstreamConnectorIds,
    ...ELIZA_COMPAT_CONNECTOR_IDS,
    ...ELIZA_LOCAL_CONNECTOR_IDS,
  ]),
) as ReadonlyArray<
  | (typeof _upstreamConnectorIds)[number]
  | (typeof ELIZA_COMPAT_CONNECTOR_IDS)[number]
  | (typeof ELIZA_LOCAL_CONNECTOR_IDS)[number]
>;
