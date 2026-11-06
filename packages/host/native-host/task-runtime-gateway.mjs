import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { NativeHostError } from "./errors.mjs";
import { initialOwnerFence, ownerFenceStep } from "./task-owner-fence.mjs";
import { openTaskDatabase } from "./task-storage.mjs";

const answer = (status, value) => Response.json(value, { status });
const unauthorized = () => answer(401, { code: "TASK_UNAUTHORIZED" });
/** The account changed after this request saved a change for the former one. */
const accountChanged = () => answer(409, { code: "TASK_ACCOUNT_CHANGED" });
const superseded = () =>
  new NativeHostError("Task authentication superseded", {
    code: "TASK_UNAUTHORIZED",
  });
/** One error as itself; several keep a code they all share. */
function combined(errors) {
  if (errors.length === 1) return errors[0];
  const error = new AggregateError(errors, "Task cleanup failed");
  const code = errors[0]?.code;
  if (errors.every((item) => item?.code === code)) error.code = code;
  return error;
}

/** The host owns identity and storage; shared code owns task transitions. */
export async function createTaskGateway({
  bundlePath,
  databasePath,
  databaseProvider,
  requireEncryptedDatabase = false,
  credentialGate,
  actuator,
  actuatorFactory,
  authorizeGoal,
  extensionFactory,
  decoratePresentation,
  onResponse,
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
  const db = await openTaskDatabase({
    databasePath,
    databaseProvider,
    requireEncryption: requireEncryptedDatabase,
  });
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
  let fence = initialOwnerFence;
  let authSequence = 0;
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
  /** Apply one fence step. A revoke tries every runtime, even after a failure. */
  function step(event) {
    const result = ownerFenceStep(fence, event);
    fence = result.fence;
    const errors = [];
    if (result.revoke)
      for (const runtime of runtimes.values())
        try {
          revoke(runtime);
        } catch (error) {
          errors.push(error);
        }
    return { decision: result.decision, errors };
  }
  async function settle(errors = []) {
    for (const runtime of runtimes.values())
      try {
        await runtime.settle();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw combined(errors);
  }
  async function readGate() {
    try {
      return (await credentialGate()) || null;
    } catch {
      return null;
    }
  }
  async function authenticate() {
    const startedEpoch = fence.epoch;
    for (let confirming = false; ; confirming = true) {
      const sequence = ++authSequence;
      const account = await readGate();
      const { decision, errors } = step({
        type: "read",
        sequence,
        startedEpoch,
        account,
        confirming,
      });
      // Read the gate once more before ending the live owner's tasks.
      if (decision === "confirm") continue;
      if (decision === "superseded") throw superseded();
      if (decision === "signed-out") {
        await settle(errors);
        throw new NativeHostError("Task account unavailable", {
          code: "TASK_UNAUTHORIZED",
        });
      }
      const committedEpoch = fence.epoch;
      await settle(errors);
      if (
        fence.closed ||
        committedEpoch !== fence.epoch ||
        fence.owner !== account
      )
        throw superseded();
      const owner = ownerFor(account);
      authenticatedEpochs.set(owner, fence.epoch);
      return owner;
    }
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
  async function handleRequest(request, scope) {
    let owner;
    try {
      owner = await authenticate();
    } catch (error) {
      return error?.code === "TASK_CLEANUP_UNCONFIRMED"
        ? answer(503, { code: error.code })
        : unauthorized();
    }
    if (fence.closed || authenticatedEpochs.get(owner) !== fence.epoch)
      return unauthorized();
    const requestEpoch = fence.epoch;
    scope.owner = owner.actorId;
    scope.epoch = requestEpoch;
    const runtime = runtimeFor(owner);
    /** True while this request still answers for the owner and epoch it began in. */
    const isCurrent = () =>
      !fence.closed &&
      !request.signal.aborted &&
      fence.epoch === requestEpoch &&
      fence.owner === owner.actorId;
    // A 401 means nothing was saved. After a saved change it is a 409.
    const refused = () => (scope.committed ? accountChanged() : unauthorized());
    /**
     * Save a change only while the request is current: read the gate, check
     * the fence, then run `write`. The durable write must happen before
     * `write` first awaits, so no account change can come between the check
     * and the write.
     */
    const commit = async (write) => {
      await authenticate();
      if (!isCurrent()) throw superseded();
      const result = write();
      scope.committed = true;
      return result;
    };
    /** Deliver a host response only if the account is still the same. */
    const fenced = async (response) => {
      try {
        const current = await authenticate();
        if (isCurrent() && current.actorId === owner.actorId) return response;
      } catch {}
      return refused();
    };
    let hostResponse;
    try {
      hostResponse = await extension?.(request, {
        owner,
        runtime,
        authenticate,
        requestEpoch,
        currentEpoch: () => fence.epoch,
        isCurrent,
        commit,
      });
    } catch (error) {
      if (error?.code === "TASK_UNAUTHORIZED" || !isCurrent()) return refused();
      throw error;
    }
    if (hostResponse !== undefined && hostResponse !== null) {
      if (!(hostResponse instanceof Response))
        throw new NativeHostError("Invalid task host extension response");
      return fenced(hostResponse);
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
          return requestEpoch === fence.epoch ? current : null;
        } catch {
          return null;
        }
      },
      authorizeGoal: authorizeGoal || unavailable,
    })(request);
  }
  return {
    /** Trusted host planner API. Never exposed as a renderer execution route. */
    async forCurrentOwner() {
      const owner = await authenticate();
      if (fence.closed || authenticatedEpochs.get(owner) !== fence.epoch)
        throw superseded();
      return runtimeFor(owner);
    },
    /** Explicit trusted-host pilot integration; never a renderer route. */
    async collectPilotEvidence(factory) {
      if (typeof factory !== "function")
        throw new NativeHostError("Pilot capture factory unavailable");
      const owner = await authenticate(),
        requestEpoch = fence.epoch;
      const capture = factory({
        db,
        tasks: store,
        owner,
        isCurrentOwner: () =>
          !fence.closed &&
          requestEpoch === fence.epoch &&
          fence.owner === owner.actorId,
      });
      return capture.collect();
    },
    /** Trusted chat adapter. No renderer-supplied widget or workflow refresh. */
    async presentationForConversation({ taskId, expectedEpoch, actorId }) {
      const owner = await authenticate(),
        requestEpoch = fence.epoch;
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
        fence.closed ||
        requestEpoch !== fence.epoch ||
        current.actorId !== actorId ||
        latest.epoch !== expectedEpoch ||
        latest.revision !== task.revision ||
        latest.status !== "active" ||
        latest.authorization.state !== "active"
      )
        throw new NativeHostError("Task changed");
      const shown = {
        taskId,
        epoch: latest.epoch,
        revision: latest.revision,
        choice,
      };
      if (typeof decoratePresentation !== "function") return shown;
      // Decoration is optional, but its wait cannot outlive task authority.
      let decorated = shown;
      try {
        decorated =
          (await decoratePresentation({
            presentation: { ...shown },
            db,
            owner,
            runtime,
          })) ?? shown;
      } catch {
        // Keep the validated presentation when optional decoration fails.
      }
      const afterDecoration = await authenticate();
      if (
        fence.closed ||
        requestEpoch !== fence.epoch ||
        afterDecoration.actorId !== actorId
      )
        throw new NativeHostError("Task changed");
      const afterTask = runtime.get(taskId);
      if (
        afterTask.epoch !== expectedEpoch ||
        afterTask.revision !== task.revision ||
        afterTask.status !== "active" ||
        afterTask.authorization.state !== "active"
      )
        throw new NativeHostError("Task changed");
      return decorated;
    },
    /** `onResponse` observes each answer; it cannot change or fail it. */
    async handle(request) {
      const scope = { owner: null, epoch: -1, committed: false };
      if (typeof onResponse !== "function")
        return handleRequest(request, scope);
      const started = performance.now();
      let response;
      try {
        response = await handleRequest(request, scope);
      } finally {
        try {
          await onResponse({
            request,
            response: response?.clone(),
            durationMs: performance.now() - started,
          });
        } catch {}
        // Fenced on the owner and epoch the request authenticated in.
        if (response?.ok) {
          let current = null;
          try {
            current = await authenticate();
          } catch {}
          if (
            fence.closed ||
            request.signal.aborted ||
            scope.epoch !== fence.epoch ||
            current?.actorId !== scope.owner
          )
            response = scope.committed ? accountChanged() : unauthorized();
        }
      }
      return response;
    },
    revoke() {
      return settle(step({ type: "revoke" }).errors);
    },
    async close() {
      if (databaseClosed) return;
      // A retried close tries again each task an earlier close could not revoke.
      const { errors } = fence.closed
        ? step({ type: "revoke" })
        : step({ type: "close" });
      await settle(errors);
      db.close();
      databaseClosed = true;
    },
  };
}
