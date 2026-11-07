/** Read-only observations of the deployed API contract, never mutation admission. */
import {
  PRIVATE_PROVIDER_FAILURES,
  type privatePitrApi,
} from "./pitr-private-api";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("contract_shape");
  return value as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw Error("contract_shape");
  return value.map(object);
}
function scalar(value: unknown, kind: string, name: string): boolean {
  const type = object(value);
  return (
    type.kind === kind &&
    type.name === name &&
    (type.ofType === null || type.ofType === undefined)
  );
}
function required(value: unknown, kind: string, name: string): boolean {
  const type = object(value);
  return type.kind === "NON_NULL" && scalar(type.ofType, kind, name);
}
export async function observeBackupContract(
  api: typeof privatePitrApi,
  signal?: AbortSignal,
) {
  try {
    const response = object(await api("backupContract", {}, signal));
    const data = object(response.data);
    const mutations = list(object(data.mutation).fields);
    const matching = mutations.filter(
      (field) => field.name === "volumeInstanceBackupCreate",
    );
    if (matching.length > 1) throw Error("contract_shape");
    const field = matching[0],
      args = field ? list(field.args) : [];
    const name = args.filter((arg) => arg.name === "name");
    const volume = args.filter((arg) => arg.name === "volumeInstanceId");
    const workflow =
      data.workflow === null ? [] : list(object(data.workflow).fields);
    const ids = workflow.filter((field) => field.name === "workflowId");
    return {
      available: true,
      mutationPresent: !!field,
      nameArgumentPresent: name.length === 1,
      nameArgumentTypeMatches:
        name.length === 1 && scalar(name[0].type, "SCALAR", "String"),
      volumeArgumentTypeMatches:
        volume.length === 1 && required(volume[0].type, "SCALAR", "String"),
      unexpectedRequiredArguments: args.some(
        (arg) =>
          arg.name !== "name" &&
          arg.name !== "volumeInstanceId" &&
          object(arg.type).kind === "NON_NULL" &&
          arg.defaultValue === null,
      ),
      returnTypeMatches:
        !!field && required(field.type, "OBJECT", "WorkflowId"),
      workflowIdFieldMatches:
        ids.length === 1 && scalar(ids[0].type, "SCALAR", "String"),
      creationAuthorized: false,
    };
  } catch (error) {
    return {
      available: false,
      failureCategory:
        error instanceof Error &&
        (PRIVATE_PROVIDER_FAILURES as readonly string[]).includes(error.message)
          ? error.message
          : "contract_unavailable",
      creationAuthorized: false,
    };
  }
}
