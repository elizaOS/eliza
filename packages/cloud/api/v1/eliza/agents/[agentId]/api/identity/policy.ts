import type { Address } from "viem";
import type { ERC8004ChainId } from "@/lib/services/erc8004/identity-client";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type StewardPolicyRule = {
  id: string;
  type: string;
  enabled: boolean;
  config?: JsonObject;
};

function arrayFromConfig(
  config: JsonObject | undefined,
  keys: string[],
): string[] {
  if (!config) return [];
  for (const key of keys) {
    const value = config[key];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function policiesAllowRegister(
  policies: StewardPolicyRule[],
  chainId: ERC8004ChainId,
  registry: Address,
): { allowed: boolean; reason?: string } {
  const enabled = policies.filter((policy) => policy.enabled);
  const allowedChains = enabled.find(
    (policy) => policy.type === "allowed-chains",
  );
  if (!allowedChains)
    return { allowed: false, reason: "missing allowed-chains policy" };
  const chains = arrayFromConfig(allowedChains.config, [
    "chainIds",
    "chains",
    "allowedChains",
  ]);
  if (!chains.map(String).includes(String(chainId))) {
    return {
      allowed: false,
      reason: `chain ${chainId} is not allowed by Steward policy`,
    };
  }

  const approvedAddresses = enabled.find(
    (policy) => policy.type === "approved-addresses",
  );
  if (!approvedAddresses)
    return { allowed: false, reason: "missing approved-addresses policy" };
  const addresses = arrayFromConfig(approvedAddresses.config, [
    "addresses",
    "approvedAddresses",
    "allowlist",
    "allowedAddresses",
  ]).map((address) => address.toLowerCase());
  if (!addresses.includes(registry.toLowerCase())) {
    return {
      allowed: false,
      reason: "IdentityRegistry address is not approved by Steward policy",
    };
  }
  return { allowed: true };
}
