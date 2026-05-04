// Override CONNECTOR_IDS to include App-local connectors.
// The wildcard re-export above is shadowed by this explicit named export.
import { CONNECTOR_IDS as _upstreamConnectorIds } from "@elizaos/agent";

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
