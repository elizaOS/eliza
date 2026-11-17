// spec/core/accountBridges.md, "Story: Install and clear shared account-selection contracts"; spec/core/accountBridges.md, "Each bridge slot preserves the last installed object identity"
import type { Driver, Options } from "../../gen/core__accountBridges.conformance.ts";
import type { BridgeReference } from "../../gen/core__accountBridges.ts";
import {
  type AnthropicAccountPoolBridge,
  type CodingAgentSelectorBridge,
  getAnthropicAccountPoolBridge,
  getCodingAgentSelectorBridge,
  setAnthropicAccountPoolBridge,
  setCodingAgentSelectorBridge,
} from "../../src/account-pool-bridge.vibe";

const modelPoolBridges = new Map<string, AnthropicAccountPoolBridge>();
const codingPoolBridges = new Map<string, CodingAgentSelectorBridge>();

const bridgeOf = <B>(identity: string, bridges: Map<string, B>, create: () => B): B => {
  const existing = bridges.get(identity);
  if (existing) return existing;
  const created = create();
  bridges.set(identity, created);
  return created;
};

const modelPoolBridge = (): AnthropicAccountPoolBridge => ({
  selectAnthropicSubscription: () => Promise.resolve(null),
  getAccessToken: () => Promise.resolve(null),
  markInvalid: () => Promise.resolve(),
  markRateLimited: () => Promise.resolve(),
});

const codingPoolBridge = (): CodingAgentSelectorBridge => ({
  describe: () => ({}),
  select: () => Promise.resolve(null),
  markRateLimited: () => Promise.resolve(),
  markNeedsReauth: () => Promise.resolve(),
  recordUsage: () => Promise.resolve(),
});

const reference = <B>(installed: B | null, bridges: Map<string, B>): BridgeReference => {
  if (installed === null) return { tag: "NoBridge" };
  const identity = [...bridges].find(([, bridge]) => bridge === installed)?.[0];
  if (identity === undefined) throw new Error("a bridge slot holds an object the driver did not install");
  return { tag: "InstalledBridge", identity };
};

export const driver: Driver = {
  reset: () => {
    setAnthropicAccountPoolBridge(null);
    setCodingAgentSelectorBridge(null);
  },
  dispatch: (_key, { slot, bridge }) => {
    if (slot === "ModelPoolSlot") {
      setAnthropicAccountPoolBridge(bridge.tag === "NoBridge" ? null : bridgeOf(bridge.identity, modelPoolBridges, modelPoolBridge));
    } else {
      setCodingAgentSelectorBridge(bridge.tag === "NoBridge" ? null : bridgeOf(bridge.identity, codingPoolBridges, codingPoolBridge));
    }
    return "accepted";
  },
  observe: () => ({
    modelPool: reference(getAnthropicAccountPoolBridge(), modelPoolBridges),
    codingPool: reference(getCodingAgentSelectorBridge(), codingPoolBridges),
  }),
};

export const options: Options = { keys: ["a"] };
