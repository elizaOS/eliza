import type {
  ConnectorAccountRecord as CoreConnectorAccountRecord,
  IDatabaseAdapter,
  UpsertConnectorAccountParams as CoreUpsertConnectorAccountParams,
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
