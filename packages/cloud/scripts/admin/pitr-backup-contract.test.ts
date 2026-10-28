import { expect, test } from "bun:test";
import { observeBackupContract } from "./pitr-backup-contract";
import { PITR_QUERIES } from "./pitr-private-api";

// Exact structural selection from the pinned Railway5.38 Mutation/WorkflowId schema.
const scalar = (name: string) => ({ kind: "SCALAR", name, ofType: null });
const required = (type: unknown) => ({
  kind: "NON_NULL",
  name: null,
  ofType: type,
});
function fixture() {
  return {
    data: {
      mutation: {
        fields: [
          {
            name: "volumeInstanceBackupCreate",
            args: [
              { name: "name", type: scalar("String"), defaultValue: null },
              {
                name: "volumeInstanceId",
                type: required(scalar("String")),
                defaultValue: null,
              },
            ],
            type: required({
              kind: "OBJECT",
              name: "WorkflowId",
              ofType: null,
            }),
          },
        ],
      },
      workflow: { fields: [{ name: "workflowId", type: scalar("String") }] },
    },
  };
}
test("fixed read-only query compares exact deployed contract without exposing schema values", async () => {
  const calls: string[] = [];
  const result = await observeBackupContract(async (op) => {
    calls.push(op);
    return fixture();
  });
  expect(calls).toEqual(["backupContract"]);
  expect(PITR_QUERIES.backupContract.startsWith("query ")).toBe(true);
  expect(result).toEqual({
    available: true,
    mutationPresent: true,
    nameArgumentPresent: true,
    nameArgumentTypeMatches: true,
    volumeArgumentTypeMatches: true,
    unexpectedRequiredArguments: false,
    returnTypeMatches: true,
    workflowIdFieldMatches: true,
    creationAuthorized: false,
  });
});
test("missing name argument, changed input/output, new required field and missing mutation are observed", async () => {
  const f = fixture();
  f.data.mutation.fields[0].args.shift();
  let result = await observeBackupContract(async () => f);
  expect("nameArgumentPresent" in result && result.nameArgumentPresent).toBe(
    false,
  );
  f.data.mutation.fields[0].args.push({
    name: "private-unknown",
    type: required(scalar("String")),
    defaultValue: null,
  });
  result = await observeBackupContract(async () => f);
  expect(
    "unexpectedRequiredArguments" in result &&
      result.unexpectedRequiredArguments,
  ).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-unknown");
  f.data.mutation.fields[0].args[0].type = required(scalar("ID"));
  f.data.workflow.fields[0].type = scalar("ID");
  result = await observeBackupContract(async () => f);
  expect(
    "volumeArgumentTypeMatches" in result && result.volumeArgumentTypeMatches,
  ).toBe(false);
  expect(
    "workflowIdFieldMatches" in result && result.workflowIdFieldMatches,
  ).toBe(false);
  f.data.mutation.fields = [];
  result = await observeBackupContract(async () => f);
  expect("mutationPresent" in result && result.mutationPresent).toBe(false);
});
test("disabled or malformed introspection gives finite unavailable evidence only", async () => {
  for (const value of [
    { data: { mutation: null, workflow: null } },
    { data: { mutation: { fields: "private-secret" } } },
  ]) {
    expect(await observeBackupContract(async () => value)).toEqual({
      available: false,
      failureCategory: "contract_unavailable",
      creationAuthorized: false,
    });
  }
  expect(
    await observeBackupContract(async () => {
      throw Error("private-secret");
    }),
  ).toEqual({
    available: false,
    failureCategory: "contract_unavailable",
    creationAuthorized: false,
  });
  expect(
    await observeBackupContract(async () => {
      throw Error("private_provider_permission");
    }),
  ).toEqual({
    available: false,
    failureCategory: "private_provider_permission",
    creationAuthorized: false,
  });
});
