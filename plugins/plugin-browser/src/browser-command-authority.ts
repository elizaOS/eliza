/**
 * Binds confirmed browser uploads to the v2 interaction authorization
 * contract. The selected session/account, adapter capability, upload
 * operation, and normalized input digest are revalidated together before a
 * receipt can be accepted; file handles never enter the receipt.
 */

import {
  type AuthorizedInteractionAction,
  authorizeInteractionDispatch,
  computeInteractionActionDigest,
  type EffectReceipt,
  ElizaError,
  INTERACTION_CONTRACT_VERSION,
  type InteractionAction,
  type InteractionCapabilitySet,
  type InteractionConfirmationGrant,
  type InteractionConfirmationGrantConsumer,
  type InteractionProfileGrantVerifier,
  type InteractionSession,
  normalizeEffectReceipt,
} from "@elizaos/core";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

export const BROWSER_UPLOAD_CAPABILITY_ID = "browser.upload";
export const BROWSER_UPLOAD_OPERATION = "browser.upload";
const BROWSER_EFFECT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface BrowserUploadActionRequest {
  actionId: string;
  requestedAt: string;
  confirmationGrant: InteractionConfirmationGrant | null;
  command: BrowserWorkspaceCommand;
  session: InteractionSession;
}

export interface BrowserUploadAuthorizationRequest
  extends BrowserUploadActionRequest {
  confirmationGrant: InteractionConfirmationGrant;
  capabilities: InteractionCapabilitySet;
  confirmationGrantConsumer: InteractionConfirmationGrantConsumer;
  profileGrantVerifier?: InteractionProfileGrantVerifier;
}

export interface BrowserAuthorizedCommandBinding {
  sessionId: string;
  accountGrantId: string;
  adapterId: string;
  capabilityId: typeof BROWSER_UPLOAD_CAPABILITY_ID;
  operation: typeof BROWSER_UPLOAD_OPERATION;
  inputDigest: string;
}

export interface BrowserAuthorizedCommandReceipt {
  contractVersion: typeof INTERACTION_CONTRACT_VERSION;
  authorizationId: string;
  actionId: string;
  binding: BrowserAuthorizedCommandBinding;
  effect: EffectReceipt;
  observedAt: string;
}

export interface AuthorizedBrowserUpload {
  action: AuthorizedInteractionAction;
  binding: BrowserAuthorizedCommandBinding;
  command: BrowserWorkspaceCommand;
}

function invalid(
  message: string,
  context: Record<string, unknown> = {},
): never {
  throw new ElizaError(message, {
    code: "INVALID_BROWSER_COMMAND_AUTHORIZATION",
    context,
    severity: "fatal",
  });
}

function nonEmpty(value: unknown, field: string, maxChars = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maxChars
  ) {
    return invalid(
      `Browser authorization field '${field}' must be a non-empty string.`,
      {
        field,
      },
    );
  }
  return value.trim();
}

function stale(message: string, sessionId: string): never {
  throw new ElizaError(message, {
    code: "STALE_INTERACTION_REFERENCE",
    context: { sessionId },
    severity: "ephemeral",
  });
}

function accountGrantForSession(session: InteractionSession) {
  if (session.profileMode !== "existing_explicit" || !session.profileGrant) {
    return invalid(
      "Bound browser upload requires an explicitly granted account profile.",
      { sessionId: session.sessionId },
    );
  }
  return session.profileGrant;
}

export function createBrowserUploadInteractionAction(
  request: BrowserUploadActionRequest,
): InteractionAction {
  if (request.command.subaction !== "upload") {
    return invalid(
      "Bound browser authorization currently supports upload only.",
      {
        subaction: request.command.subaction,
      },
    );
  }
  const elementId = nonEmpty(
    request.command.selector,
    "command.selector",
    4_096,
  );
  const fileHandles = request.command.files?.map((file, index) =>
    nonEmpty(file, `command.files[${index}]`, 4_096),
  );
  if (!fileHandles || fileHandles.length === 0) {
    return invalid(
      "Bound browser upload requires at least one opaque file handle.",
    );
  }
  if (
    fileHandles.length > 32 ||
    new Set(fileHandles).size !== fileHandles.length
  ) {
    return invalid(
      "Bound browser upload file handles must be unique and limited to 32 entries.",
    );
  }
  if (request.command.id !== undefined && !request.command.id.trim()) {
    return invalid("Bound browser upload surface id cannot be blank.");
  }
  const requestedSurfaceId = request.command.id?.trim();
  const surface = requestedSurfaceId
    ? request.session.surfaces.find(
        (candidate) => candidate.surfaceId === requestedSurfaceId,
      )
    : request.session.surfaces.find(
        (candidate) => candidate.kind === "browser_tab",
      );
  if (surface?.kind !== "browser_tab") {
    return invalid(
      "Bound browser upload requires a current browser-tab surface.",
      {
        sessionId: request.session.sessionId,
      },
    );
  }
  return {
    contractVersion: INTERACTION_CONTRACT_VERSION,
    actionId: nonEmpty(request.actionId, "actionId"),
    sessionId: request.session.sessionId,
    adapterId: request.session.adapterId,
    surface,
    kind: "upload",
    payload: { elementId, fileHandles },
    observationId: null,
    observationSequence: null,
    requestedAt: nonEmpty(request.requestedAt, "requestedAt"),
    confirmationGrant: request.confirmationGrant,
    leaseIds: [],
  };
}

/** Atomically consumes the exact confirmation before returning dispatchable input. */
export async function authorizeBrowserUpload(
  request: BrowserUploadAuthorizationRequest,
): Promise<AuthorizedBrowserUpload> {
  if (request.session.adapterId !== request.capabilities.adapterId) {
    return invalid(
      "Browser session and capability adapter identities differ.",
      {
        sessionId: request.session.sessionId,
      },
    );
  }
  if (!request.capabilities.controlPlanes.includes("browser")) {
    return invalid("Selected adapter does not advertise browser control.", {
      adapterId: request.capabilities.adapterId,
    });
  }
  if (!request.capabilities.actionKinds.includes("upload")) {
    return invalid(
      "Selected browser adapter does not advertise upload capability.",
      {
        adapterId: request.capabilities.adapterId,
      },
    );
  }
  const action = createBrowserUploadInteractionAction(request);
  const accountGrant = accountGrantForSession(request.session);
  if (
    Date.parse(request.session.updatedAt) > Date.parse(action.requestedAt) ||
    Date.parse(accountGrant.issuedAt) > Date.parse(action.requestedAt)
  ) {
    return stale(
      "Browser session or account grant changed after the upload was requested.",
      request.session.sessionId,
    );
  }
  const accountProfileHandle = accountGrant.profileHandle;
  const accountGrantId = accountGrant.grantId;
  const authorized = await authorizeInteractionDispatch(action, {
    session: request.session,
    capabilities: request.capabilities,
    confirmationGrantConsumer: request.confirmationGrantConsumer,
    ...(request.profileGrantVerifier
      ? { profileGrantVerifier: request.profileGrantVerifier }
      : {}),
    leaseRequirements: [],
  });
  if (
    accountGrantForSession(request.session).profileHandle !==
      accountProfileHandle ||
    request.session.profileGrant?.grantId !== accountGrantId
  ) {
    return stale(
      "Browser account grant changed while dispatch authorization was pending.",
      request.session.sessionId,
    );
  }
  const payload = authorized.payload as {
    elementId: string;
    fileHandles: string[];
  };
  const binding = Object.freeze({
    sessionId: request.session.sessionId,
    accountGrantId,
    adapterId: request.session.adapterId,
    capabilityId: BROWSER_UPLOAD_CAPABILITY_ID,
    operation: BROWSER_UPLOAD_OPERATION,
    inputDigest: computeInteractionActionDigest(authorized),
  });
  return Object.freeze({
    action: authorized,
    binding,
    command: Object.freeze({
      subaction: "upload" as const,
      id: authorized.surface.surfaceId,
      selector: payload.elementId,
      files: [...payload.fileHandles],
    }),
  });
}

/** Creates the receipt only after the exact authorized target reports success. */
export function createBrowserUploadReceipt(
  authorized: AuthorizedBrowserUpload,
  result: BrowserWorkspaceCommandResult,
  effectValue: unknown,
): BrowserAuthorizedCommandReceipt {
  if (result.tab && result.tab.id !== authorized.action.surface.surfaceId) {
    return invalid("Browser upload result came from a different surface.", {
      actionId: authorized.action.actionId,
    });
  }
  if (result.subaction !== "upload") {
    return invalid("Browser upload result reports a different operation.", {
      actionId: authorized.action.actionId,
      subaction: result.subaction,
    });
  }
  const effect = normalizeEffectReceipt(effectValue);
  const requestedAt = Date.parse(authorized.action.requestedAt);
  const observedAt = Date.parse(effect.observedAt);
  const committedAt =
    effect.outcome === "applied" ? Date.parse(effect.commit.committedAt) : NaN;
  if (
    effect.operation !== BROWSER_UPLOAD_OPERATION ||
    effect.resource.kind !== "browser.surface" ||
    effect.resource.id !== authorized.action.surface.surfaceId ||
    effect.resource.version !== String(authorized.action.surface.generation) ||
    effect.idempotency.key !== authorized.action.actionId ||
    effect.idempotency.replayed ||
    effect.outcome !== "applied" ||
    committedAt < requestedAt ||
    observedAt < committedAt ||
    observedAt > Date.now() + BROWSER_EFFECT_CLOCK_SKEW_MS
  ) {
    return invalid(
      "Browser target did not return effect proof for the exact authorized upload.",
      {
        actionId: authorized.action.actionId,
        receiptId: effect.receiptId,
      },
    );
  }
  return Object.freeze({
    contractVersion: INTERACTION_CONTRACT_VERSION,
    authorizationId:
      authorized.action.confirmationGrant?.confirmationId ??
      invalid("Authorized browser upload lost its confirmation grant.", {
        actionId: authorized.action.actionId,
      }),
    actionId: authorized.action.actionId,
    binding: authorized.binding,
    effect,
    observedAt: effect.observedAt,
  });
}

/**
 * Revalidates an untrusted receipt against the expected session and exact
 * action. A receipt is never authoritative without this trusted context.
 */
export function normalizeBrowserUploadReceipt(
  value: unknown,
  expected: {
    action: InteractionAction;
    session: InteractionSession;
  },
): BrowserAuthorizedCommandReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Browser upload receipt must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const bindingRaw = raw.binding;
  if (
    bindingRaw === null ||
    typeof bindingRaw !== "object" ||
    Array.isArray(bindingRaw)
  ) {
    return invalid("Browser upload receipt binding must be an object.");
  }
  const binding = bindingRaw as Record<string, unknown>;
  const expectedBinding = {
    sessionId: expected.session.sessionId,
    accountGrantId: accountGrantForSession(expected.session).grantId,
    adapterId: expected.session.adapterId,
    capabilityId: BROWSER_UPLOAD_CAPABILITY_ID,
    operation: BROWSER_UPLOAD_OPERATION,
    inputDigest: computeInteractionActionDigest(expected.action),
  } as const;
  for (const [field, expectedValue] of Object.entries(expectedBinding)) {
    if (binding[field] !== expectedValue) {
      return invalid(
        "Browser upload receipt binding does not match trusted context.",
        {
          actionId: expected.action.actionId,
          field,
        },
      );
    }
  }
  const authorizationId = nonEmpty(raw.authorizationId, "authorizationId");
  if (
    expected.action.confirmationGrant?.confirmationId !== authorizationId ||
    raw.actionId !== expected.action.actionId ||
    raw.contractVersion !== INTERACTION_CONTRACT_VERSION
  ) {
    return invalid(
      "Browser upload receipt authorization identity does not match.",
      {
        actionId: expected.action.actionId,
      },
    );
  }
  const effect = normalizeEffectReceipt(raw.effect);
  const requestedAt = Date.parse(expected.action.requestedAt);
  const observedEffectAt = Date.parse(effect.observedAt);
  const committedAt =
    effect.outcome === "applied" ? Date.parse(effect.commit.committedAt) : NaN;
  if (
    effect.operation !== BROWSER_UPLOAD_OPERATION ||
    effect.resource.kind !== "browser.surface" ||
    effect.resource.id !== expected.action.surface.surfaceId ||
    effect.resource.version !== String(expected.action.surface.generation) ||
    effect.idempotency.key !== expected.action.actionId ||
    effect.idempotency.replayed ||
    effect.outcome !== "applied" ||
    committedAt < requestedAt ||
    observedEffectAt < committedAt ||
    observedEffectAt > Date.now() + BROWSER_EFFECT_CLOCK_SKEW_MS
  ) {
    return invalid(
      "Browser upload effect receipt cannot be relabeled onto this action.",
      {
        actionId: expected.action.actionId,
        receiptId: effect.receiptId,
      },
    );
  }
  const observedAt = nonEmpty(raw.observedAt, "observedAt");
  if (effect.observedAt !== observedAt) {
    return invalid(
      "Browser upload receipt timestamps do not match its effect proof.",
      {
        actionId: expected.action.actionId,
      },
    );
  }
  return Object.freeze({
    contractVersion: INTERACTION_CONTRACT_VERSION,
    authorizationId,
    actionId: expected.action.actionId,
    binding: Object.freeze(expectedBinding),
    effect,
    observedAt,
  });
}

export type BrowserAuthorizedUploadExecution = {
  result: BrowserWorkspaceCommandResult;
  receipt: BrowserAuthorizedCommandReceipt;
};
