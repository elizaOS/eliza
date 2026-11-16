// SPEC.md, "Conformance": spec/core/accountBridges.md against the shared bridge slots of src/account-pool-bridge.vibe, process-wide, observed as the identity of the object each getter returns
import type { Driver, Options } from "../../gen/core__accountBridges.conformance.ts";
import type { AccountBridges, BridgeReference } from "../../gen/core__accountBridges.ts";
import {
  type AnthropicAccountPoolBridge,
  type CodingAgentSelectorBridge,
  getAnthropicAccountPoolBridge,
  getCodingAgentSelectorBridge,
  setAnthropicAccountPoolBridge,
  setCodingAgentSelectorBridge,
} from "../../src/account-pool-bridge.vibe";

const anthropicBridges = new Map<string, AnthropicAccountPoolBridge>();
const codingBridges = new Map<string, CodingAgentSelectorBridge>();

const anthropicBridge = (identity: string): AnthropicAccountPoolBridge => {
  const existing = anthropicBridges.get(identity);
  if (existing) return existing;
  const created: AnthropicAccountPoolBridge = {
    selectAnthropicSubscription: () => Promise.resolve(null),
    getAccessToken: () => Promise.resolve(null),
    markInvalid: () => Promise.resolve(),
    markRateLimited: () => Promise.resolve(),
  };
  anthropicBridges.set(identity, created);
  return created;
};

const codingBridge = (identity: string): CodingAgentSelectorBridge => {
  const existing = codingBridges.get(identity);
  if (existing) return existing;
  const created: CodingAgentSelectorBridge = {
    describe: () => ({}),
    select: () => Promise.resolve(null),
    markRateLimited: () => Promise.resolve(),
    markNeedsReauth: () => Promise.resolve(),
    recordUsage: () => Promise.resolve(),
  };
  codingBridges.set(identity, created);
  return created;
};

const reference = <B>(installed: B | null, bridges: Map<string, B>): BridgeReference => {
  if (installed === null) return { tag: "NoBridge" };
  const identity = [...bridges].find(([, bridge]) => bridge === installed)?.[0];
  if (identity === undefined) throw new Error("a bridge slot holds an object the driver did not install");
  return { tag: "InstalledBridge", identity };
};

export const driver: Driver<AccountBridges> = {
  reset: () => {
    setAnthropicAccountPoolBridge(null);
    setCodingAgentSelectorBridge(null);
  },
  dispatch: (_key, event) => {
    const { bridge } = event;
    if (event.type === "setAnthropic") {
      setAnthropicAccountPoolBridge(bridge.tag === "NoBridge" ? null : anthropicBridge(bridge.identity));
    } else {
      setCodingAgentSelectorBridge(bridge.tag === "NoBridge" ? null : codingBridge(bridge.identity));
    }
    return "accepted";
  },
  observe: () => ({
    anthropic: reference(getAnthropicAccountPoolBridge(), anthropicBridges),
    coding: reference(getCodingAgentSelectorBridge(), codingBridges),
  }),
};

export const options: Options<AccountBridges> = { keys: ["a"] };
