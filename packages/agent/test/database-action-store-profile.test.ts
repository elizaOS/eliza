/**
 * DATABASE query honours allowWrites only on a direct build with no store
 * distribution profile and no product host policy, like the TERMINAL gate.
 */
import { _resetBuildVariantForTests } from "@elizaos/host";
import { afterEach, expect, it, vi } from "vitest";
import { databaseAction } from "../src/actions/database.ts";

function fakeRuntime() {
  const execute = vi.fn(async () => ({ rows: [], fields: [] }));
  return { runtime: { adapter: { db: { execute } } }, execute };
}

async function insert(runtime: unknown) {
  const handler = databaseAction.handler;
  if (!handler) throw new Error("DATABASE handler is missing");
  const result = await handler(
    runtime as never,
    {} as never,
    undefined,
    {
      parameters: {
        action: "query",
        sql: "INSERT INTO notes (id) VALUES (1)",
        allowWrites: true,
      },
    },
    undefined,
  );
  if (!result) throw new Error("DATABASE returned nothing");
  return result;
}

afterEach(() => {
  vi.unstubAllEnvs();
  _resetBuildVariantForTests();
});

it.each([
  { ELIZA_DISTRIBUTION_PROFILE: "store" },
  { ELIZA_BUILD_VARIANT: "store" },
  { ELIZA_HOST_OPERATION_POLICY: "product" },
])("refuses a write with allowWrites under %o", async (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  _resetBuildVariantForTests();
  const { runtime, execute } = fakeRuntime();
  const result = await insert(runtime);
  expect(result.success).toBe(false);
  expect(result.values).toMatchObject({ reason: "WRITES_DISABLED" });
  expect(execute).not.toHaveBeenCalled();
});
