/**
 * Fail-loud stand-ins for core exports that DB-free cloud tests bind only
 * through unreachable transitive module paths.
 */

export { DEFAULT_MAX_BODY_BYTES } from "../../../../core/src/api/http-helpers";
export {
  ElizaError,
  isElizaError,
  toElizaError,
} from "../../../../core/src/errors";
export {
  toWellFormedUnicode,
  truncateWellFormed,
} from "../../../../core/src/utils/well-formed";

function unavailable(name: string): never {
  throw new Error(`@elizaos/core ${name} is outside this test path`);
}

function unavailableFunction(name: string): (...args: unknown[]) => never {
  return () => unavailable(name);
}

function unavailableConstructor(name: string) {
  return class {
    constructor() {
      unavailable(name);
    }
  };
}

function unavailableObject(name: string): object {
  return new Proxy(Object.create(null), {
    get: () => unavailable(name),
    set: () => unavailable(name),
  });
}

export const canRequesterMutateDocument = unavailableFunction(
  "canRequesterMutateDocument",
);
export const ChannelType = unavailableObject("ChannelType");
export const DatabaseAdapter = unavailableConstructor("DatabaseAdapter");
export const decryptedCharacter = unavailableFunction("decryptedCharacter");
export const DOCUMENT_LIST_QUERY_CAPABILITY_VERSION = Symbol(
  "DOCUMENT_LIST_QUERY_CAPABILITY_VERSION outside this test path",
);
export const documentMutationSnapshotMatches = unavailableFunction(
  "documentMutationSnapshotMatches",
);
export const documentRoleHasGlobalVisibility = unavailableFunction(
  "documentRoleHasGlobalVisibility",
);
export const encryptedCharacter = unavailableFunction("encryptedCharacter");
export const isConnectorConfigured = unavailableFunction(
  "isConnectorConfigured",
);
export const logger = unavailableObject("logger");
export const readJsonBody = unavailableFunction("readJsonBody");
export const readRequestBody = unavailableFunction("readRequestBody");
export const readRequestBodyBuffer = unavailableFunction(
  "readRequestBodyBuffer",
);
export const sendJson = unavailableFunction("sendJson");
export const sendJsonError = unavailableFunction("sendJsonError");
export const normalizePairingPageOptions = unavailableFunction(
  "normalizePairingPageOptions",
);
export const Service = unavailableConstructor("Service");
export const validateDocumentFragmentQueryParams = unavailableFunction(
  "validateDocumentFragmentQueryParams",
);
export const validateDocumentListQueryParams = unavailableFunction(
  "validateDocumentListQueryParams",
);
export const validateDocumentRequesterContext = unavailableFunction(
  "validateDocumentRequesterContext",
);
export const validateQueryEntitiesPagination = unavailableFunction(
  "validateQueryEntitiesPagination",
);
export const validateUuid = unavailableFunction("validateUuid");
