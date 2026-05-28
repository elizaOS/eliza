import { describe, expect, test } from "bun:test";
import { ERC8004_IDENTITY_REGISTRY_ADDRESSES } from "@/lib/services/erc8004/identity-client";
import {
  policiesAllowRegister,
  type StewardPolicyRule,
} from "../v1/eliza/agents/[agentId]/api/identity/policy";

const registry = ERC8004_IDENTITY_REGISTRY_ADDRESSES[56];

function policies(opts: {
  chain?: string;
  address?: string;
}): StewardPolicyRule[] {
  return [
    {
      id: "allowed-chains",
      type: "allowed-chains",
      enabled: true,
      config: { chainIds: [opts.chain ?? "56"] },
    },
    {
      id: "approved-addresses",
      type: "approved-addresses",
      enabled: true,
      config: { addresses: [opts.address ?? registry] },
    },
  ];
}

describe("ERC-8004 Steward policy gate", () => {
  test("allows register when chain and registry are approved", () => {
    expect(policiesAllowRegister(policies({}), 56, registry)).toEqual({
      allowed: true,
    });
  });

  test("returns 403-equivalent denial reason when policy denies the chain", () => {
    expect(
      policiesAllowRegister(policies({ chain: "97" }), 56, registry),
    ).toEqual({
      allowed: false,
      reason: "chain 56 is not allowed by Steward policy",
    });
  });

  test("returns 403-equivalent denial reason when registry is not allowlisted", () => {
    expect(
      policiesAllowRegister(
        policies({ address: "0x0000000000000000000000000000000000000001" }),
        56,
        registry,
      ),
    ).toEqual({
      allowed: false,
      reason: "IdentityRegistry address is not approved by Steward policy",
    });
  });
});
