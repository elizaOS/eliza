/** Trusted renderer adapter for the embedded native page, not a website API. */
import { pageCommand } from "./page-command.mjs";
import { pageGuidance } from "./page-guidance.mjs";
import { BridgeError } from "./protocol.mjs";
import { createTaskBindings } from "./task-bindings.mjs";
import { createTaskGuidance } from "./task-guidance.mjs";

const validPageId = (id) =>
  typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
const failure = (code, message) =>
  Object.assign(new BridgeError(code, message), { code });
const stale = () =>
  failure("STALE_REF", "The selected page or task changed; observe again.");

/**
 * One account/renderer lifetime. getPage returns the selected native page with
 * an immutable selection lease expressed by isCurrent(). control rechecks that
 * lease at the native boundary. cleanup can only hide/pause annotations, even
 * on parked pages; it must retain native owner/session checks. listPages returns
 * existing surfaces, including parked ones, so absence is never guessed.
 * None of these ports may accept model- or website-supplied authority.
 */
export function createSurfaceTaskHandler({
  getPage,
  listPages,
  control,
  cleanup,
  isCurrent,
}) {
  const bindings = new Map(),
    records = new Map(),
    observations = new Map();
  let retired = false,
    processing = Promise.resolve(),
    bindingQueue = Promise.resolve();
  const alive = () => !retired && isCurrent();
  const api = {
    storage: {
      local: {
        get: async (key) => ({ [key]: records.get(key) }),
        set: async (values) => {
          for (const [key, value] of Object.entries(values))
            records.set(key, structuredClone(value));
        },
      },
    },
    tabs: { query: listPages },
    scripting: {
      executeScript: async ({ target, func, args, world }) => {
        if (
          !alive() ||
          world !== "ISOLATED" ||
          target.frameIds?.length !== 1 ||
          target.frameIds[0] !== 0
        )
          throw stale();
        const id = target.tabId;
        if (
          func === pageGuidance &&
          ["hide", "pause"].includes(args[0]?.kind)
        ) {
          const result = await cleanup(id, args[0].kind);
          if (!alive()) throw stale();
          return [{ result }];
        }
        if (func !== pageGuidance && func !== pageCommand)
          throw failure(
            "UNSUPPORTED",
            "Only fixed native page operations are supported.",
          );
        const observation = observations.get(id);
        if (!observation?.page.isCurrent()) throw stale();
        const page = await getPage(id);
        if (
          !alive() ||
          page.id !== id ||
          !page.isCurrent() ||
          !observation.page.isCurrent()
        )
          throw stale();
        const command =
          func === pageGuidance
            ? { subaction: "guide", guidance: args[0] }
            : { ...args[0], validateOnly: args[2] === true };
        const reply = await control(page, {
          documentId: observation.documentId,
          command,
        });
        if (!alive() || !page.isCurrent() || !observation.page.isCurrent())
          throw stale();
        if (reply.documentId !== observation.documentId) throw stale();
        return [{ documentId: reply.documentId, result: reply.result }];
      },
    },
  };
  const authority = createTaskBindings({
    bindings,
    read: async (key) => records.get(key),
    write: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    clearGuidance: async (id) => {
      observations.delete(id);
      await guidance.clearTab(id);
    },
    getUrl: async (id) => (await getPage(id)).url,
    validTabId: validPageId,
  });
  const guidance = createTaskGuidance(api, authority.scope, {
    validTabId: validPageId,
    pageId: (id) => id,
  });
  const requireCurrent = (current) => {
    if (!current()) throw stale();
  };
  const run = async (message, signal) => {
    const current = () => alive() && !signal?.aborted;
    requireCurrent(current);
    if (
      !message ||
      typeof message !== "object" ||
      typeof message.id !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(message.id)
    )
      throw failure(
        "INVALID_REQUEST",
        "A unique command identity is required.",
      );
    if (message.type === "current-page") {
      if (Object.keys(message).some((key) => !["type", "id"].includes(key)))
        throw failure("INVALID_REQUEST", "Invalid current-page request.");
      const page = await getPage();
      requireCurrent(current);
      if (!page) return null;
      if (!validPageId(page.id) || !page.isCurrent()) throw stale();
      const url = new URL(page.url);
      if (url.protocol !== "https:" || url.username || url.password)
        return null;
      return { tabId: page.id, origin: url.origin, title: page.title ?? "" };
    }
    if (message.type === "task-guide") {
      if (
        message.guidance?.answers !== undefined ||
        message.guidance?.tone === "offer"
      )
        throw failure("UNSUPPORTED", "Answers belong in the trusted host.");
      return guidance.handle(message, current);
    }
    if (
      message.type !== "command" ||
      Object.keys(message).some(
        (key) => !["type", "id", "command"].includes(key),
      )
    )
      throw failure("INVALID_REQUEST", "Invalid surface command.");
    const command = message.command;
    if (
      !command ||
      !validPageId(command.id) ||
      !command.taskContext ||
      !["snapshot", "click", "fill", "select", "scroll"].includes(
        command.subaction,
      ) ||
      Object.keys(command).some(
        (key) =>
          ![
            "subaction",
            "id",
            "taskContext",
            "taskExpiresAt",
            "selector",
            "text",
            "direction",
            "expectedSelector",
            "actionText",
          ].includes(key),
      )
    )
      throw failure(
        "POLICY_BLOCKED",
        "A fixed command with a bound task is required.",
      );
    const key = `request:${message.id}`;
    if (records.has(key))
      throw failure(
        "UNCERTAIN_OUTCOME",
        "This request was already admitted; observe without replaying it.",
      );
    const scoped = await authority.scope(command);
    const page = await getPage(command.id);
    const valid = () =>
      current() &&
      scoped.current() &&
      page.id === command.id &&
      page.isCurrent();
    requireCurrent(valid);
    records.set(key, "admitted");
    if (command.subaction === "snapshot") {
      observations.delete(page.id);
      const reply = await control(
        page,
        {
          command: {
            subaction: "snapshot",
            taskPolicy: scoped.command.taskPolicy,
          },
        },
        signal,
      );
      requireCurrent(valid);
      const result = reply.result;
      if (
        reply.frameScope !== "main" ||
        typeof reply.documentId !== "string" ||
        !result?.complete ||
        typeof result.snapshotId !== "string" ||
        !Array.isArray(result.elements) ||
        new URL(result.url).origin !== scoped.command.taskPolicy.origin
      )
        throw failure(
          "INCOMPLETE_SNAPSHOT",
          "The native page observation is incomplete or changed origin.",
        );
      observations.set(page.id, {
        page,
        documentId: reply.documentId,
        snapshotId: result.snapshotId,
      });
      return {
        id: page.id,
        snapshotId: result.snapshotId,
        frames: [
          {
            ...result,
            frameId: 0,
            documentId: reply.documentId,
            elements: result.elements.map(({ id, ...element }) => ({
              ...element,
              selector: `${result.snapshotId}:0:${id}`,
            })),
          },
        ],
      };
    }
    const observation = observations.get(page.id);
    const match = /^([0-9a-f-]{36}):0:(\d+)$/.exec(command.selector ?? "");
    if (
      !observation?.page.isCurrent() ||
      !match ||
      match[1] !== observation.snapshotId
    )
      throw stale();
    let feedback,
      outcome,
      fault,
      inputDispatched = false;
    try {
      feedback = await guidance.prepareAction(
        scoped.command,
        message.id,
        valid,
      );
      requireCurrent(() => valid() && feedback.current());
      observations.delete(page.id);
      inputDispatched = true;
      const reply = await control(
        page,
        {
          documentId: observation.documentId,
          command: {
            ...scoped.command,
            snapshotId: match[1],
            nodeId: match[2],
            taskPolicy: {
              ...scoped.command.taskPolicy,
              actionId: feedback.actionId,
            },
          },
        },
        signal,
      );
      if (
        !valid() ||
        !feedback.current() ||
        reply.documentId !== observation.documentId ||
        reply.result?.dispatched !== true
      )
        throw failure(
          "UNCERTAIN_OUTCOME",
          "The page effect needs fresh readback; do not replay it.",
        );
      outcome = reply.result;
    } catch (error) {
      fault = { error };
    }
    try {
      await guidance.cancel(message.id);
    } catch (error) {
      // Cleanup cannot turn a completed/unknown effect into a pre-effect
      // STALE_REF refusal that the task runtime could retry.
      fault = {
        error: inputDispatched
          ? failure(
              "UNCERTAIN_OUTCOME",
              "The input may have run, but guidance cleanup was not confirmed; observe without replaying.",
            )
          : error,
      };
    }
    if (fault) throw fault.error;
    return outcome;
  };
  const handle = (input, { signal } = {}) => {
    // Copy before queueing; a caller cannot change authority during an await.
    const message = structuredClone(input);
    const invoke = async () => {
      try {
        return await run(message, signal);
      } catch (error) {
        if (error?.kind && !error.code) error.code = error.kind;
        throw error;
      }
    };
    if (message?.type === "task-bind") {
      const bound = bindingQueue.then(() =>
        authority.bind(message, () => alive() && !signal?.aborted),
      );
      bindingQueue = bound.catch(() => {});
      return bound.catch((error) => {
        if (error?.kind && !error.code) error.code = error.kind;
        throw error;
      });
    }
    const next = processing.then(invoke);
    processing = next.catch(() => {});
    return next;
  };
  handle.close = async () => {
    retired = true;
    observations.clear();
    for (const [id, binding] of bindings)
      bindings.set(id, { ...binding, revoked: true });
    // Cleanup uses the host's separate owner-fenced port after task retirement.
    await Promise.all(
      (await listPages()).map((page) => cleanup(page.id, "hide")),
    );
  };
  return handle;
}
