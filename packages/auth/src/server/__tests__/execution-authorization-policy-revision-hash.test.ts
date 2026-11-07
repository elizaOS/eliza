import { describe, expect, test } from "bun:test";
import { policyRevisionHashForPolicySet } from "../api/services/execution-authorization.ts";
import type { PolicyRule } from "../shared/index.ts";

// Policy ids are caller-chosen (tenant defaultPolicies, per-agent policy
// creation) with no charset constraint, so mixed-case and "aa"-initial ids
// are valid inputs. ICU collation orders this set differently from the
// code-unit order the canonical serializer pins for object keys: in every
// locale "apple-approval" collates before "Zebra-allowlist", and under
// da-DK "aa-rate-limit" (aa = å) sorts after "b-spending-limit". A
// localeCompare sort therefore made policyRevisionHash depend on the
// host's default locale even for an unchanged policy set.
const POLICIES: PolicyRule[] = [
  { id: "aa-rate-limit", type: "rate-limit", enabled: true, config: {} },
  { id: "b-spending-limit", type: "spending-limit", enabled: true, config: {} },
  {
    id: "Zebra-allowlist",
    type: "contract-allowlist",
    enabled: true,
    config: {},
  },
  {
    id: "apple-approval",
    type: "auto-approve-threshold",
    enabled: true,
    config: {},
  },
];

// SHA-256 of the canonical JSON of the same set sorted in code-unit order
// (Zebra-allowlist, aa-rate-limit, apple-approval, b-spending-limit) — the
// order canonicalJsonStringify already pins for the digest's object keys.
const CODE_UNIT_ORDER_DIGEST =
  "cb04cf1cd9b17513cc8b8a6a5ab8fc50954da4eb8d99c28a86a57bc1ed30c758";

describe("policyRevisionHashForPolicySet", () => {
  test("hashes the policy set in code-unit order", () => {
    expect(policyRevisionHashForPolicySet(POLICIES)).toBe(
      CODE_UNIT_ORDER_DIGEST,
    );
  });

  test("does not depend on the caller's array order", () => {
    const shuffled = [POLICIES[2], POLICIES[0], POLICIES[3], POLICIES[1]];
    expect(policyRevisionHashForPolicySet(shuffled)).toBe(
      CODE_UNIT_ORDER_DIGEST,
    );
  });

  test("does not depend on input order when two entries share an id", () => {
    const first: PolicyRule = {
      id: "dup-limit",
      type: "spending-limit",
      enabled: true,
      config: { maxPerDay: "100" },
    };
    const second: PolicyRule = {
      id: "dup-limit",
      type: "spending-limit",
      enabled: false,
      config: { maxPerDay: "200" },
    };
    expect(policyRevisionHashForPolicySet([first, second])).toBe(
      policyRevisionHashForPolicySet([second, first]),
    );
  });
});
