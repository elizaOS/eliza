import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { NativeHostError } from "./errors.mjs";

/** The host owns identity and storage; shared code owns task transitions. */
export async function createTaskGateway({
  bundlePath,
  databasePath,
  credentialGate,
  actuator,
  actuatorFactory,
  authorizeGoal,
  extensionFactory,
  agentId = "eliza",
  connectorSource = "native-gateway",
}) {
  if (!agentId || !connectorSource || typeof credentialGate !== "function")
    throw new NativeHostError(
      "Explicit task host identity and authentication are required",
    );
  const manifest = JSON.parse(await readFile(`${bundlePath}.json`, "utf8"));
  if (
    manifest.schemaVersion !== 2 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
  )
    throw new NativeHostError("Invalid task runtime provenance");
  const bytes = await readFile(bundlePath);
  if (
    createHash("sha256").update(bytes).digest("hex") !== manifest.bundleSha256
  )
    throw new NativeHostError("Task runtime bundle integrity failed");
  const {
    SqliteInteractiveTaskStore,
    InteractiveTaskRuntime,
    createInteractiveTaskHandler,
    SqliteMessageInteractionSessionStore,
    InteractiveTaskChoices,
    SqliteTaskPresentation,
  } = await import(pathToFileURL(bundlePath).href);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = process.versions.bun
    ? new (await import("bun:sqlite")).Database(databasePath, { create: true })
    : new (await import("node:sqlite")).DatabaseSync(databasePath);
  await chmod(databasePath, 0o600);
  db.exec("PRAGMA synchronous = FULL");
  const store = new SqliteInteractiveTaskStore(db);
  const choiceStore = new SqliteMessageInteractionSessionStore(db);
  const extension = extensionFactory?.({
    db,
    store,
    choiceStore,
    InteractiveTaskChoices,
    SqliteTaskPresentation,
  });
  db.exec(
    "CREATE TABLE IF NOT EXISTS browser_binding_revisions (tab_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
  );
  const nextBindingRevision = (tabId) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare(
          "SELECT revision FROM browser_binding_revisions WHERE tab_id = ?",
        )
        .get(tabId);
      const revision = (previous?.revision || 0) + 1;
      if (!Number.isSafeInteger(revision))
        throw new NativeHostError("Browser binding revision exhausted");
      db.prepare(
        "INSERT INTO browser_binding_revisions(tab_id, revision) VALUES (?, ?) ON CONFLICT(tab_id) DO UPDATE SET revision=excluded.revision",
      ).run(tabId, revision);
      db.exec("COMMIT");
      return revision;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const runtimes = new Map();
  let activeOwner = null;
  let epoch = 0;
  let authSequence = 0;
  let settledAuthSequence = 0;
  let closed = false;
  let databaseClosed = false;
  const authenticatedEpochs = new WeakMap();
  const ownerFor = (account) => ({
    actorId: account,
    agentId,
    connector: { source: connectorSource, accountId: account },
  });
  const unavailable = () => {
    throw new NativeHostError("Native helper is unavailable");
  };
  const adapter = actuator || {
    capabilities: [],
    observe: unavailable,
    execute: unavailable,
  };
  function revoke(runtime) {
    const task = runtime.current();
    if (task && task.authorization.state === "active")
      runtime.control(task.id, task.revision, "revoke");
  }
  async function settle() {
    for (const runtime of runtimes.values()) await runtime.settle();
  }
  async function authenticate() {
    const startedEpoch = epoch;
    const sequence = ++authSequence;
    let account, failure;
    try {
      account = await credentialGate();
    } catch (error) {
      failure = error;
    }
    // A late credential result must not change ownership or revoke a newer task.
    if (
      closed ||
      startedEpoch !== epoch ||
      (sequence < settledAuthSequence &&
        (failure || !account || account !== activeOwner))
    )
      throw new NativeHostError("Task authentication superseded");
    settledAuthSequence = Math.max(settledAuthSequence, sequence);
    if (failure || !account) {
      epoch++;
      activeOwner = null;
      for (const runtime of runtimes.values()) revoke(runtime);
      await settle();
      throw new NativeHostError("Task account unavailable");
    }
    if (activeOwner && activeOwner !== account) {
      epoch++;
      for (const runtime of runtimes.values()) revoke(runtime);
    }
    activeOwner = account;
    const committedEpoch = epoch;
    await settle();
    if (closed || committedEpoch !== epoch || activeOwner !== account)
      throw new NativeHostError("Task authentication superseded");
    const owner = ownerFor(account);
    authenticatedEpochs.set(owner, epoch);
    return owner;
  }
  function runtimeFor(owner) {
    let runtime = runtimes.get(owner.actorId);
    if (!runtime) {
      const ownedActuator =
        actuatorFactory?.({
          owner,
          nextBindingRevision,
          getTask: (id) => {
            const task = store.get(id, owner);
            if (!task)
              throw new NativeHostError("Task is not owned by this account");
            return task;
          },
        }) || adapter;
      runtime = new InteractiveTaskRuntime({
        owner,
        store,
        actuator: ownedActuator,
      });
      runtimes.set(owner.actorId, runtime);
    }
    return runtime;
  }
  // Restore before accepting requests, so an immediate logout also revokes a
  // prior process's task. An unbound account may still use the login routes.
  let initialOwner;
  try {
    initialOwner = await authenticate();
  } catch {
    initialOwner = null;
  }
  if (initialOwner) runtimeFor(initialOwner);
  return {
    /** Trusted host planner API. Never exposed as a renderer execution route. */
    async forCurrentOwner() {
      const owner = await authenticate();
      if (closed || authenticatedEpochs.get(owner) !== epoch)
        throw new NativeHostError("Task authentication superseded");
      return runtimeFor(owner);
    },
    /** Explicit trusted-host pilot integration; never a renderer route. */
    async collectPilotEvidence(factory) {
      if (typeof factory !== "function")
        throw new NativeHostError("Pilot capture factory unavailable");
      const owner = await authenticate(),
        requestEpoch = epoch;
      const capture = factory({
        db,
        tasks: store,
        owner,
        isCurrentOwner: () =>
          !closed && requestEpoch === epoch && activeOwner === owner.actorId,
      });
      return capture.collect();
    },
    /** Trusted chat adapter. No renderer-supplied widget or workflow refresh. */
    async presentationForConversation({ taskId, expectedEpoch, actorId }) {
      const owner = await authenticate(),
        requestEpoch = epoch;
      if (owner.actorId !== actorId)
        throw new NativeHostError("Task account changed");
      const runtime = runtimeFor(owner),
        task = runtime.get(taskId);
      if (
        task.epoch !== expectedEpoch ||
        task.status !== "active" ||
        task.authorization.state !== "active"
      )
        throw new NativeHostError("Task changed");
      const presentation = new SqliteTaskPresentation(
        db,
        runtime,
        new InteractiveTaskChoices(runtime, choiceStore),
      );
      const choice = await presentation.read(taskId);
      const current = await authenticate(),
        latest = runtime.get(taskId);
      if (
        closed ||
        requestEpoch !== epoch ||
        current.actorId !== actorId ||
        latest.epoch !== expectedEpoch ||
        latest.revision !== task.revision ||
        latest.status !== "active" ||
        latest.authorization.state !== "active"
      )
        throw new NativeHostError("Task changed");
      return { taskId, epoch: latest.epoch, revision: latest.revision, choice };
    },
    async handle(request) {
      let owner;
      try {
        owner = await authenticate();
      } catch (error) {
        return error?.code === "TASK_CLEANUP_UNCONFIRMED"
          ? Response.json({ code: error.code }, { status: 503 })
          : Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
      }
      if (closed || authenticatedEpochs.get(owner) !== epoch)
        return Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
      const requestEpoch = epoch;
      const runtime = runtimeFor(owner);
      const extensionResponse = await extension?.(request, {
        owner,
        runtime,
        authenticate,
        requestEpoch,
        currentEpoch: () => epoch,
      });
      if (extensionResponse !== undefined && extensionResponse !== null) {
        if (!(extensionResponse instanceof Response))
          throw new NativeHostError("Invalid task host extension response");
        const current = await authenticate();
        if (
          closed ||
          request.signal.aborted ||
          requestEpoch !== epoch ||
          current.actorId !== owner.actorId
        )
          return Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
        return extensionResponse;
      }
      // Do not create a cosmetic task when the actual helper is unavailable.
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/tasks" &&
        ((!actuator && !actuatorFactory) || !authorizeGoal)
      )
        return Response.json(
          { code: "TASK_HELPER_UNAVAILABLE" },
          { status: 503 },
        );
      return createInteractiveTaskHandler({
        runtime,
        authenticate: async () => {
          try {
            const current = await authenticate();
            return requestEpoch === epoch ? current : null;
          } catch {
            return null;
          }
        },
        authorizeGoal: authorizeGoal || unavailable,
      })(request);
    },
    revoke() {
      epoch++;
      activeOwner = null;
      for (const runtime of runtimes.values()) revoke(runtime);
      return settle();
    },
    async close() {
      if (databaseClosed) return;
      if (!closed) {
        closed = true;
        epoch++;
        for (const runtime of runtimes.values()) revoke(runtime);
      }
      await settle();
      if (!databaseClosed) {
        db.close();
        databaseClosed = true;
      }
    },
  };
}
