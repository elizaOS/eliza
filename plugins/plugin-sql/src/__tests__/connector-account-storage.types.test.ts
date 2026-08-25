/**
 * Compile-time check (no runtime assertions beyond expectTypeOf) that
 * plugin-sql's re-exported connector-account storage types stay identical to
 * the `@elizaos/core` contract types, including the adapter method signature.
 */
import type {
  ConnectorAccountRecord as CoreConnectorAccountRecord,
  UpsertConnectorAccountParams as CoreUpsertConnectorAccountParams,
  IDatabaseAdapter,
} from "@elizaos/core";
import { describe, expectTypeOf, it } from "vitest";
import type {
  ConnectorAccountRecord as SqlConnectorAccountRecord,
  UpsertConnectorAccountParams as SqlUpsertConnectorAccountParams,
} from "../index";

describe("connector account storage types", () => {
  it("re-exports the core connector account storage contract types", () => {
    expectTypeOf<SqlConnectorAccountRecord>().toEqualTypeOf<CoreConnectorAccountRecord>();
    expectTypeOf<SqlUpsertConnectorAccountParams>().toEqualTypeOf<CoreUpsertConnectorAccountParams>();
    expectTypeOf<
      Parameters<IDatabaseAdapter["upsertConnectorAccount"]>[0]
    >().toEqualTypeOf<CoreUpsertConnectorAccountParams>();
  });
});
