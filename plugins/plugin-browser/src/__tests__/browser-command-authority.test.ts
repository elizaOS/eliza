/**
 * Exercises bound browser-upload authorization through the real dispatcher
 * with an in-process consume-once coordinator and a deterministic target.
 */

import {
  computeInteractionActionDigest,
  type IAgentRuntime,
  INTERACTION_CONTRACT_VERSION,
  InteractionConfirmationCoordinator,
  type InteractionSession,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBrowserUploadInteractionAction,
  normalizeBrowserUploadReceipt,
} from "../browser-command-authority.js";
import { BrowserService } from "../browser-service.js";
import { executeBrowserWorkspaceCommand } from "../workspace/browser-workspace.js";
import {
  createDesktopBrowserWorkspaceCommandScript,
  executeDesktopBrowserWorkspaceDomCommand,
  executeDesktopBrowserWorkspaceUtilityCommand,
} from "../workspace/browser-workspace-desktop.js";
import { executeWebBrowserWorkspaceUtilityCommand } from "../workspace/browser-workspace-web.js";

const now = Date.parse("2026-08-18T22:00:00.000Z");
const requestedAt = "2026-08-18T21:59:00.000Z";
const expiresAt = "2026-08-18T22:05:00.000Z";
beforeAll(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterAll(() => vi.restoreAllMocks());
const profileGrantVerifier = {
  verify: (
    grant: { profileHandle: string },
    context: { ownerId: string; adapterId: string },
  ) =>
    grant.profileHandle === "account-opaque-1" &&
    context.ownerId === "owner-1" &&
    context.adapterId === capabilities.adapterId,
};

const capabilities = {
  contractVersion: INTERACTION_CONTRACT_VERSION,
  adapterId: "workspace-account-1",
  controlPlanes: ["browser"],
  surfaceKinds: ["browser_tab"],
  observationChannels: ["dom"],
  actionKinds: ["upload"],
  background: { mode: "none", requiresForeground: ["upload"] },
  profileAccess: { modes: ["existing_explicit"], requiresExplicitGrant: true },
  concurrency: { mode: "single_surface", maxSessions: 1, sharedResources: [] },
  limitations: [],
} as const;

function session(
  ownerId = "owner-1",
  profileHandle = "account-opaque-1",
): InteractionSession {
  return {
    contractVersion: INTERACTION_CONTRACT_VERSION,
    sessionId: "session-1",
    ownerId,
    adapterId: capabilities.adapterId,
    state: "ready",
    isolationMode: "managed_browser",
    profileMode: "existing_explicit",
    generation: 3,
    createdAt: "2026-08-18T21:50:00.000Z",
    updatedAt: "2026-08-18T21:58:00.000Z",
    expiresAt,
    profileGrant: {
      grantId: "profile-grant-1",
      sessionId: "session-1",
      ownerId,
      adapterId: capabilities.adapterId,
      profileHandle,
      issuedAt: "2026-08-18T21:49:00.000Z",
      expiresAt,
    },
    surfaces: [
      {
        sessionId: "session-1",
        adapterId: capabilities.adapterId,
        surfaceId: "tab-1",
        kind: "browser_tab",
        generation: 3,
        parentSurfaceId: null,
      },
    ],
  };
}

const command = {
  subaction: "upload" as const,
  id: "tab-1",
  selector: "#attachment",
  files: ["opaque-file-handle-1"],
};

function confirmedUpload(activeSession: InteractionSession = session()) {
  const coordinator = new InteractionConfirmationCoordinator();
  const draft = createBrowserUploadInteractionAction({
    actionId: "upload-action-1",
    requestedAt,
    confirmationGrant: null,
    command,
    session: activeSession,
  });
  coordinator.register(
    {
      confirmationId: "confirmation-1",
      actionId: draft.actionId,
      taxonomy: "browser.upload",
      origin: null,
      destination: null,
      disclosures: ["One selected file will be attached to the current page."],
      consequence: "The selected page receives the file attachment.",
      actionDigest: computeInteractionActionDigest(draft),
      requestedAt,
      expiresAt,
    },
    draft,
    now,
  );
  const grant = coordinator.issue(
    "confirmation-1",
    draft,
    "2026-08-18T22:00:00.000Z",
    now,
  );
  return { coordinator, draft, grant };
}

function serviceWithTarget() {
  const service = new BrowserService({} as IAgentRuntime);
  const genericExecute = vi.fn(async (dispatched: typeof command) => ({
    mode: "desktop" as const,
    subaction: dispatched.subaction,
    value: { attached: dispatched.files?.length ?? 0 },
  }));
  const execute = vi.fn(
    async (
      action: ReturnType<typeof createBrowserUploadInteractionAction>,
    ) => ({
      result: {
        mode: "desktop" as const,
        subaction: "upload" as const,
        value: { attached: 1 },
      },
      effectReceipt: {
        receiptId: `browser-upload:${action.actionId}`,
        operation: "browser.upload",
        resource: {
          kind: "browser.surface",
          id: action.surface.surfaceId,
          version: String(action.surface.generation),
        },
        artifacts: [],
        idempotency: { key: action.actionId, replayed: false },
        observedAt: new Date(now).toISOString(),
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: "provider-acceptance-1",
          committedAt: new Date(now).toISOString(),
        },
      },
    }),
  );
  const target = {
    id: capabilities.adapterId,
    name: "Bound workspace account",
    description: "Deterministic browser target",
    available: async () => true,
    supports: (candidate) => candidate.subaction === "upload",
    execute: genericExecute,
    executeAuthorizedUpload: execute,
  };
  service.registerTarget(target);
  return { execute, genericExecute, service, target };
}

describe("bound browser command authorization", () => {
  it("blocks upload and eval on the generic dispatcher", async () => {
    const { execute, genericExecute, service } = serviceWithTarget();

    await expect(
      service.execute(command, capabilities.adapterId),
    ).rejects.toMatchObject({
      kind: "POLICY_BLOCKED",
    });
    await expect(
      service.execute(
        { subaction: "eval", id: "tab-1", script: "document.cookie" },
        capabilities.adapterId,
      ),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    await expect(
      service.execute({
        subaction: "batch",
        steps: [{ subaction: "state" }, command],
      }),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    expect(execute).not.toHaveBeenCalled();
    expect(genericExecute).not.toHaveBeenCalled();
    await expect(executeBrowserWorkspaceCommand(command, {})).rejects.toThrow(
      "proof-producing target",
    );
    await expect(
      executeBrowserWorkspaceCommand(
        { ...command, subaction: "realistic-upload" },
        {},
      ),
    ).rejects.toThrow("proof-producing target");
    await expect(
      executeWebBrowserWorkspaceUtilityCommand(command),
    ).rejects.toThrow("proof-producing target");
    await expect(
      executeDesktopBrowserWorkspaceUtilityCommand(command, {}),
    ).rejects.toThrow("proof-producing target");
  });

  it("does not consume confirmation when the pinned target lacks upload proof", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const consume = vi.fn(coordinator.consume.bind(coordinator));
    const service = new BrowserService({} as IAgentRuntime);
    service.registerTarget({
      id: capabilities.adapterId,
      name: "Generic target",
      description: "No proof-producing upload hook",
      available: async () => true,
      supports: () => true,
      execute: vi.fn(),
    });

    await expect(
      service.executeConfirmedUpload(command, {
        actionId: draft.actionId,
        requestedAt,
        confirmationGrant: grant,
        confirmationGrantConsumer: { consume },
        profileGrantVerifier,
        session: activeSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(consume).not.toHaveBeenCalled();
  });

  it("consumes an exact confirmation and emits a context-bound receipt", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();

    const output = await service.executeConfirmedUpload(command, {
      actionId: draft.actionId,
      requestedAt,
      confirmationGrant: grant,
      confirmationGrantConsumer: coordinator,
      profileGrantVerifier,
      session: activeSession,
      capabilities,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "upload",
        payload: {
          elementId: "#attachment",
          fileHandles: ["opaque-file-handle-1"],
        },
      }),
    );
    expect(output.receipt.binding).toMatchObject({
      sessionId: "session-1",
      accountGrantId: "profile-grant-1",
      adapterId: capabilities.adapterId,
      capabilityId: "browser.upload",
      operation: "browser.upload",
      inputDigest: computeInteractionActionDigest({
        ...draft,
        confirmationGrant: grant,
      }),
    });
    expect(JSON.stringify(output.receipt)).not.toContain(
      "opaque-file-handle-1",
    );
    expect(JSON.stringify(output.receipt)).not.toContain("account-opaque-1");
    expect(JSON.stringify(output.receipt)).not.toContain("owner-1");
    expect(
      normalizeBrowserUploadReceipt(output.receipt, {
        action: { ...draft, confirmationGrant: grant },
        session: activeSession,
      }),
    ).toEqual(output.receipt);
  });

  it("rejects concurrent replay before a second dispatch", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();
    const authorization = {
      actionId: draft.actionId,
      requestedAt,
      confirmationGrant: grant,
      confirmationGrantConsumer: coordinator,
      profileGrantVerifier,
      session: activeSession,
      capabilities,
    };

    const attempts = await Promise.allSettled([
      service.executeConfirmedUpload(command, authorization),
      service.executeConfirmedUpload(command, authorization),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects account-grant substitution during atomic confirmation consume", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();
    const consume = vi.fn(
      async (...args: Parameters<typeof coordinator.consume>) => {
        await coordinator.consume(...args);
        if (!activeSession.profileGrant) {
          throw new Error("Test fixture requires a profile grant.");
        }
        activeSession.profileGrant = {
          ...activeSession.profileGrant,
          grantId: "profile-grant-2",
          profileHandle: "account-opaque-2",
        };
      },
    );

    await expect(
      service.executeConfirmedUpload(command, {
        actionId: draft.actionId,
        requestedAt,
        confirmationGrant: grant,
        confirmationGrantConsumer: { consume },
        profileGrantVerifier: {
          verify: (_profileGrant, context) =>
            context.ownerId === "owner-1" &&
            context.adapterId === capabilities.adapterId,
        },
        session: activeSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: "STALE_INTERACTION_REFERENCE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats invalid post-dispatch effect proof as an uncertain outcome", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();
    execute.mockImplementationOnce(async (action) => ({
      result: {
        mode: "desktop" as const,
        subaction: "upload" as const,
        value: { attached: 1 },
      },
      effectReceipt: {
        receiptId: `browser-upload:${action.actionId}`,
        operation: "browser.submit",
        resource: {
          kind: "browser.surface",
          id: action.surface.surfaceId,
          version: String(action.surface.generation),
        },
        artifacts: [],
        idempotency: { key: action.actionId, replayed: false },
        observedAt: new Date(now).toISOString(),
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: "provider-receipt-1",
          committedAt: new Date(now - 1_000).toISOString(),
        },
      },
    }));
    const authorization = {
      actionId: draft.actionId,
      requestedAt,
      confirmationGrant: grant,
      confirmationGrantConsumer: coordinator,
      profileGrantVerifier,
      session: activeSession,
      capabilities,
    };

    await expect(
      service.executeConfirmedUpload(command, authorization),
    ).rejects.toMatchObject({ kind: "UNCERTAIN_OUTCOME" });
    await expect(
      service.executeConfirmedUpload(command, authorization),
    ).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects account substitution and receipt relabeling", async () => {
    const activeSession = session();
    const { coordinator, draft, grant } = confirmedUpload(activeSession);
    const { service } = serviceWithTarget();
    const output = await service.executeConfirmedUpload(command, {
      actionId: draft.actionId,
      requestedAt,
      confirmationGrant: grant,
      confirmationGrantConsumer: coordinator,
      profileGrantVerifier,
      session: activeSession,
      capabilities,
    });
    const confirmedAction = { ...draft, confirmationGrant: grant };

    expect(() =>
      normalizeBrowserUploadReceipt(
        {
          ...output.receipt,
          binding: {
            ...output.receipt.binding,
            accountGrantId: "profile-grant-2",
          },
        },
        { action: confirmedAction, session: activeSession },
      ),
    ).toThrow("binding does not match");
    expect(() =>
      normalizeBrowserUploadReceipt(
        {
          ...output.receipt,
          effect: { ...output.receipt.effect, operation: "browser.submit" },
        },
        { action: confirmedAction, session: activeSession },
      ),
    ).toThrow("cannot be relabeled");

    const substitutedSession = session("owner-2", "account-opaque-2");
    const secondCoordinator = new InteractionConfirmationCoordinator();
    secondCoordinator.register(
      {
        confirmationId: "confirmation-2",
        actionId: draft.actionId,
        taxonomy: "browser.upload",
        origin: null,
        destination: null,
        disclosures: [],
        consequence: "Attach a file.",
        actionDigest: computeInteractionActionDigest(draft),
        requestedAt,
        expiresAt,
      },
      draft,
      now,
    );
    const secondGrant = secondCoordinator.issue(
      "confirmation-2",
      draft,
      "2026-08-18T22:00:00.000Z",
      now,
    );
    await expect(
      service.executeConfirmedUpload(command, {
        actionId: draft.actionId,
        requestedAt,
        confirmationGrant: secondGrant,
        confirmationGrantConsumer: secondCoordinator,
        profileGrantVerifier,
        session: substitutedSession,
        capabilities,
      }),
    ).rejects.toThrow("not current and host-verified");
  });

  it("blocks normalized aliases and direct desktop upload helpers", async () => {
    const { genericExecute, service } = serviceWithTarget();
    await expect(
      service.execute({
        subaction: "state",
        operation: "UPLOAD" as "upload",
        selector: "#attachment",
        files: ["opaque-file-handle-1"],
      }),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    await expect(
      service.execute({ subaction: " EVAL" as "eval", script: "1" }),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    await expect(
      service.execute({ subaction: "REALISTIC_UPLOAD" as "realistic-upload" }),
    ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    await expect(
      executeBrowserWorkspaceCommand(
        { subaction: "eval", script: "1" },
        { ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT: "1" },
      ),
    ).rejects.toThrow(/script execution is disabled|Generic browser eval/);
    expect(() =>
      createDesktopBrowserWorkspaceCommandScript({
        subaction: "realistic-upload",
        selector: "#attachment",
        files: ["opaque-file-handle-1"],
      }),
    ).toThrow("proof-producing target");
    await expect(
      executeDesktopBrowserWorkspaceDomCommand(
        {
          subaction: "realistic-upload",
          selector: "#attachment",
          files: ["opaque-file-handle-1"],
        },
        {},
      ),
    ).rejects.toThrow("proof-producing target");
    expect(genericExecute).not.toHaveBeenCalled();
  });

  it("binds authorization to a browser capability and pre-request account grant", async () => {
    const changedSession = session();
    changedSession.updatedAt = "2026-08-18T22:00:00.000Z";
    if (!changedSession.profileGrant) throw new Error("missing profile grant");
    changedSession.profileGrant = {
      ...changedSession.profileGrant,
      grantId: "profile-grant-2",
      profileHandle: "account-opaque-2",
      issuedAt: "2026-08-18T22:00:00.000Z",
    };
    const { coordinator, draft, grant } = confirmedUpload(changedSession);
    const consume = vi.fn(coordinator.consume.bind(coordinator));
    const { execute, service } = serviceWithTarget();

    await expect(
      service.executeConfirmedUpload(command, {
        actionId: draft.actionId,
        requestedAt,
        confirmationGrant: grant,
        confirmationGrantConsumer: { consume },
        profileGrantVerifier: { verify: () => true },
        session: changedSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ code: "STALE_INTERACTION_REFERENCE" });
    expect(consume).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const activeSession = session();
    const confirmed = confirmedUpload(activeSession);
    await expect(
      service.executeConfirmedUpload(command, {
        actionId: confirmed.draft.actionId,
        requestedAt,
        confirmationGrant: confirmed.grant,
        confirmationGrantConsumer: confirmed.coordinator,
        profileGrantVerifier,
        session: activeSession,
        capabilities: { ...capabilities, controlPlanes: [] },
      }),
    ).rejects.toThrow("does not advertise browser control");
  });

  it("treats a mismatched result operation as uncertain", async () => {
    const activeSession = session();
    const confirmed = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();
    execute.mockImplementationOnce(async (action) => ({
      result: { mode: "desktop", subaction: "navigate" },
      effectReceipt: {
        receiptId: `browser-upload:${action.actionId}`,
        operation: "browser.upload",
        resource: {
          kind: "browser.surface",
          id: action.surface.surfaceId,
          version: String(action.surface.generation),
        },
        artifacts: [],
        idempotency: { key: action.actionId, replayed: false },
        observedAt: new Date(now).toISOString(),
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: "provider-receipt-1",
          committedAt: new Date(now).toISOString(),
        },
      },
    }));
    await expect(
      service.executeConfirmedUpload(command, {
        actionId: confirmed.draft.actionId,
        requestedAt,
        confirmationGrant: confirmed.grant,
        confirmationGrantConsumer: confirmed.coordinator,
        profileGrantVerifier,
        session: activeSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ kind: "UNCERTAIN_OUTCOME" });
  });

  it("rejects stale effect chronology and mutable target identity", async () => {
    const activeSession = session();
    const staleProof = confirmedUpload(activeSession);
    const { execute, service } = serviceWithTarget();
    const defaultExecution = execute.getMockImplementation();
    if (!defaultExecution) throw new Error("missing target implementation");
    execute.mockImplementationOnce(async (action) => {
      const output = await defaultExecution(action);
      return {
        ...output,
        effectReceipt: {
          ...output.effectReceipt,
          commit: {
            kind: "provider_accepted" as const,
            id: "provider-acceptance-stale",
            committedAt: "2026-08-18T21:58:59.000Z",
          },
        },
      };
    });
    await expect(
      service.executeConfirmedUpload(command, {
        actionId: staleProof.draft.actionId,
        requestedAt,
        confirmationGrant: staleProof.grant,
        confirmationGrantConsumer: staleProof.coordinator,
        profileGrantVerifier,
        session: activeSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ kind: "UNCERTAIN_OUTCOME" });

    const changedTarget = serviceWithTarget();
    changedTarget.target.available = async () => {
      changedTarget.target.id = "substituted-adapter";
      return true;
    };
    const targetProof = confirmedUpload(activeSession);
    const consume = vi.fn(
      targetProof.coordinator.consume.bind(targetProof.coordinator),
    );
    await expect(
      changedTarget.service.executeConfirmedUpload(command, {
        actionId: targetProof.draft.actionId,
        requestedAt,
        confirmationGrant: targetProof.grant,
        confirmationGrantConsumer: { consume },
        profileGrantVerifier,
        session: activeSession,
        capabilities,
      }),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(consume).not.toHaveBeenCalled();
    expect(changedTarget.execute).not.toHaveBeenCalled();
  });
});
