import { BrowserFiles } from "../../../plugin-files/src/browser/files.ts";
import { BrowserStorageVolume } from "../../../plugin-files/src/browser/storage-volume.ts";
import {
  type DeviceActionClientProfile,
  DeviceActionCoordinator,
  type DeviceActionJournal,
  type DeviceContextEnvelope,
  type DeviceJournalEntry,
  type DeviceOperation,
} from "../../src/services/device-actions/client-coordinator.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function runFilesReviewScenario(
  scenario: "refresh" | "old-list" | "old-identities" | "cancelled-identities",
) {
  const namespace = crypto.randomUUID();
  const library = new BrowserFiles({
    databaseName: `files-review-${namespace}`,
    archiveName: "Files.zip",
    pdfWorkerUrl: "/unused",
    pdfAssetsBase: "/unused",
    openSelectedDocumentViewer() {
      throw Error("No document viewer in this storage scenario");
    },
    async runFilePicker(choose) {
      return choose(new AbortController().signal);
    },
    async inputFiles() {
      throw Error("No file picker in this storage scenario");
    },
  });
  await library.createFolder({ id: "root", name: "Documents" });
  await library.importFile(new File(["original bytes"], "example.txt"));
  const volume = new BrowserStorageVolume(library, {
    trashFolder: ".review-trash",
    trashKey: `files-review-trash-${namespace}`,
  });
  const paths = ["example.txt"];
  const originalIdentity = (await volume.reviewedIdentities(paths))[0];
  const session = {
    ownerId: "owner",
    agentId: "agent",
    sessionId: "session",
    origin: location.origin,
  };
  const credential = {
    installationId: "device",
    enrollmentId: "enrollment",
    key: "a".repeat(64),
    capabilities: ["files.browser.v1"],
  };
  const operation = {
    type: "files_move",
    paths,
    dest: "Documents",
    // The model's suggestion must never select the reviewed storage object.
    reviewed: ["x".repeat(43)],
  };
  let state = "pending";
  let attemptId: string | undefined;
  const proposal = () => ({
    id: "proposal",
    digest: "b".repeat(64),
    state,
    subjectUserId: session.ownerId,
    requestedBy: session.agentId,
    action: "device_action",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    payload: {
      action: "device_action",
      version: 1,
      installationId: credential.installationId,
      enrollmentId: credential.enrollmentId,
      operation,
    },
    ...(attemptId ? { execution: { attemptId } } : {}),
  });

  // Host ports are explicit fixtures. The tested state owners are the real
  // coordinator and the real IndexedDB Files library, not this server/journal.
  const journalKey = `files-review-journal-${namespace}`;
  const getEntry = (): DeviceJournalEntry | null =>
    JSON.parse(localStorage.getItem(journalKey) ?? "null");
  const saveEntry = (entry: DeviceJournalEntry) =>
    localStorage.setItem(journalKey, JSON.stringify(entry));
  const journal: DeviceActionJournal = {
    async reserve(input) {
      const entry = getEntry();
      if (entry) return { created: false, entry };
      const created: DeviceJournalEntry = { ...input, phase: "reserved" };
      saveEntry(created);
      return { created: true, entry: created };
    },
    async markApplying(input) {
      const entry = getEntry();
      if (!entry) throw Error("Missing fixture journal reservation");
      saveEntry({ ...entry, phase: "applying", attemptId: input.attemptId });
    },
    async finish(input) {
      const entry = getEntry();
      if (!entry) throw Error("Missing fixture journal dispatch");
      saveEntry({ ...entry, ...input, phase: "terminal" });
    },
    async get() {
      return { entry: getEntry() };
    },
    async list() {
      const entry = getEntry();
      return { entries: entry ? [entry] : [] };
    },
  };
  const unavailable = () => {
    throw Error("No workflow operation in this Files scenario");
  };
  const profile: DeviceActionClientProfile = {
    appName: "Files review conformance",
    operations: {
      admitView: () => true,
      parseWorkflowRead: unavailable,
    },
    workflow: {
      parseBinding: unavailable,
      parseRead: unavailable,
      validateResult: unavailable,
      assertOperation: unavailable,
    },
    presentRecord: () => undefined,
    browserNavigationSummary: unavailable,
    mapsSelectionCurrent: () => false,
    namedCalendarReadTarget: () => undefined,
    foregroundHidden: () => false,
  };
  const listEntered = gate<void>();
  const oldList = gate<{ proposals: ReturnType<typeof proposal>[] }>();
  const identityEntered = gate<void>();
  const oldIdentity = gate<void>();
  let listCalls = 0;
  let identityCalls = 0;
  let executedIdentities: string[] | undefined;
  let outcomes: { path: string; status: string; to?: string }[] = [];
  const coordinator = new DeviceActionCoordinator({
    session,
    credential,
    scope: "c".repeat(64),
    journal,
    profile,
    async request(path, body, signal) {
      signal.throwIfAborted();
      if (body === undefined) {
        if (scenario === "old-list" && ++listCalls === 1) {
          listEntered.resolve();
          return oldList.promise;
        }
        return { proposals: [proposal()] };
      }
      if (path.endsWith("/decision")) state = "approved";
      if (path.endsWith("/claim")) {
        state = "executing";
        attemptId = "attempt";
      }
      if (path.endsWith("/receipt")) state = "done";
      return { proposal: proposal(), digest: "b".repeat(64) };
    },
    async filesIdentity(selected, signal) {
      const identities = await volume.reviewedIdentities(selected);
      identityCalls++;
      if (
        (scenario === "old-identities" ||
          scenario === "cancelled-identities") &&
        identityCalls === 1
      ) {
        identityEntered.resolve();
        await oldIdentity.promise;
      }
      signal.throwIfAborted();
      return identities;
    },
    async execute(op: DeviceOperation) {
      if (op.type !== "files_move") throw Error("Unexpected Files operation");
      executedIdentities = op.reviewed;
      const result = await volume.transfer(
        op.paths,
        op.dest,
        false,
        op.reviewed,
      );
      outcomes = result.outcomes;
      return {
        status: outcomes.some((outcome) => outcome.status === "moved")
          ? "succeeded"
          : "failed",
        summary: "Reviewed Files move finished",
      };
    },
  });
  const context: DeviceContextEnvelope = {
    view: "files",
    revision: 1,
    sensitive: false,
  };
  let approvalContext = context;
  const signal = () => new AbortController().signal;
  const replaceFile = async () => {
    const row = (await library.list({})).entries.find(
      (entry) => entry.name === "example.txt",
    );
    if (!row) throw Error("Missing original file");
    await library.delete({
      id: row.id,
      expectedRevision: row.revision,
      confirmPermanent: true,
    });
    await library.importFile(new File(["replacement bytes"], "example.txt"));
  };
  let staleOutcome: string | undefined;
  let cards = 0;

  if (scenario === "old-list") {
    const older = coordinator.pendingReview(context, signal()).then(
      () => "returned",
      (error: Error) => error.name,
    );
    await listEntered.promise;
    cards = (await coordinator.pendingReview(context, signal())).length;
    await replaceFile();
    oldList.resolve({ proposals: [] });
    staleOutcome = await older;
    await coordinator.pendingReview(context, signal());
  } else if (
    scenario === "old-identities" ||
    scenario === "cancelled-identities"
  ) {
    const controller = new AbortController();
    const older = coordinator.pendingReview(context, controller.signal).then(
      () => "returned",
      (error: Error) => error.name,
    );
    await identityEntered.promise;
    if (scenario === "cancelled-identities") {
      controller.abort();
      await replaceFile();
      oldIdentity.resolve();
      staleOutcome = await older;
      cards = (await coordinator.pendingReview(context, signal())).length;
    } else {
      approvalContext = { ...context, revision: 2 };
      cards = (await coordinator.pendingReview(approvalContext, signal()))
        .length;
      oldIdentity.resolve();
      staleOutcome = await older;
    }
  } else {
    cards = (await coordinator.pendingReview(context, signal())).length;
    await replaceFile();
    await coordinator.pendingReview(context, signal());
  }

  let approvalError: string | undefined;
  try {
    await coordinator.approve("proposal", approvalContext, signal());
  } catch (error) {
    approvalError = String(error);
  }
  const root = await library.list({});
  const destination = root.entries.find((entry) => entry.name === "Documents");
  if (!destination) throw Error("Missing destination folder");
  const target = await library.list({ id: destination.id });
  const source = root.entries.find((entry) => entry.name === "example.txt");
  const moved = target.entries.find((entry) => entry.name === "example.txt");
  const bytes = async (id: string | undefined) => {
    if (!id) return null;
    const selected = await library.select({ id });
    const attachment = await library.attachment({
      selectionId: selected.selectionId,
    });
    await library.forgetSelected({ selectionId: selected.selectionId });
    return atob(attachment.dataBase64);
  };
  return {
    cards,
    staleOutcome,
    approvalError,
    identityCalls,
    originalIdentity,
    executedIdentities,
    outcomes,
    sourceBytes: await bytes(source?.id),
    movedBytes: await bytes(moved?.id),
    journalPhase: getEntry()?.phase,
  };
}
