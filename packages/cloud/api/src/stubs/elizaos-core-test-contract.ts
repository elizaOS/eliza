/**
 * Fail-loud stand-ins for core exports that DB-free cloud tests bind only
 * through unreachable transitive module paths.
 */

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
export const canRequesterManageDocumentDirectGrants = unavailableFunction(
  "canRequesterManageDocumentDirectGrants",
);
export const ChannelType = unavailableObject("ChannelType");
export const cloneConnectorJsonObject = unavailableFunction(
  "cloneConnectorJsonObject",
);
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
export const IDENTITY_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const IdentityResolutionService = unavailableConstructor(
  "IdentityResolutionService",
);
export const logger = unavailableObject("logger");
export const normalizePairingPageOptions = unavailableFunction(
  "normalizePairingPageOptions",
);
export const Service = unavailableConstructor("Service");
export const redactConnectorJsonAudit = unavailableFunction(
  "redactConnectorJsonAudit",
);
export function toWellFormedUnicode(text: string): string {
  const native = (
    String.prototype as { toWellFormed?: (this: string) => string }
  ).toWellFormed;
  if (native) return native.call(text);

  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = text.charCodeAt(index + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "�";
    } else {
      output += text[index];
    }
  }
  return output;
}
export const validateDocumentDirectGrantEntityIds = unavailableFunction(
  "validateDocumentDirectGrantEntityIds",
);
export const validateDocumentFragmentQueryParams = unavailableFunction(
  "validateDocumentFragmentQueryParams",
);
export const validateDocumentListQueryParams = unavailableFunction(
  "validateDocumentListQueryParams",
);
export const validateDocumentRequesterContext = unavailableFunction(
  "validateDocumentRequesterContext",
);
export const validateDocumentRevisionReplacement = unavailableFunction(
  "validateDocumentRevisionReplacement",
);
export const validateQueryEntitiesPagination = unavailableFunction(
  "validateQueryEntitiesPagination",
);
export const validateUuid = unavailableFunction("validateUuid");
