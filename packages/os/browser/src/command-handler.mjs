/** Consumes native requests once; cancellation bypasses the command queue. */
import { executeCommand, prepareCommand } from "./commands.mjs";
import {
  createManualActivity,
  installManualActivity,
} from "./manual-activity.mjs";
import { BridgeError, parseCommand } from "./protocol.mjs";
import { createTaskBindings } from "./task-bindings.mjs";
import { createTaskGuidance } from "./task-guidance.mjs";

export function createCommandHandler(api) {
  let protectionAdvisory = null;
  let protectionRevision = 0;
  const cancelled = new Set();
  const bindings = new Map();
  const activity = createManualActivity(api, (tabId) => bindings.get(tabId));
  let bindingQueue = Promise.resolve();
  const guidance = createTaskGuidance(api, (...args) => scope(...args));
  const { bind, scope, blocked, validId } = createTaskBindings({
    bindings,
    read: async (key) => (await api.storage.local.get(key))[key],
    write: (key, value) => api.storage.local.set({ [key]: value }),
    clearGuidance: (tabId) => guidance.clearTab(tabId),
    getUrl: async (tabId) => (await api.tabs.get(Number(tabId))).url,
    validTabId: (value) =>
      typeof value === "string" &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)),
  });
  let processing = Promise.resolve();

  async function handle(message, sender, connectionCurrent) {
    let isCurrent = connectionCurrent;
    let request;
    try {
      if (!isCurrent()) return;
      request = parseCommand(message);
      isCurrent = () => connectionCurrent() && !cancelled.has(request.id);
      if (!isCurrent()) return;
      const key = `request:${request.id}`;
      const previous = (await api.storage.local.get(key))[key];
      if (previous)
        throw new BridgeError(
          "UNCERTAIN_OUTCOME",
          "This request ID was already admitted; inspect the same tab before issuing a new request.",
        );
      const scoped = await scope(request.command);
      const transportCurrent = isCurrent;
      isCurrent = () => transportCurrent() && scoped.current();
      request.command = scoped.command;
      const prepared = await prepareCommand(api, request.command);
      if (!isCurrent()) return;
      await api.storage.local.set({ [key]: "admitted" });
      if (!isCurrent()) return;
      let feedback;
      if (
        request.command.taskPolicy &&
        ["click", "fill", "select", "scroll", "follow"].includes(
          request.command.subaction,
        )
      ) {
        feedback = await guidance.prepareAction(
          request.command,
          request.id,
          isCurrent,
        );
        request.command.taskPolicy.actionId = feedback.actionId;
        const priorCurrent = isCurrent;
        isCurrent = () => priorCurrent() && feedback.current();
      }
      let result;
      try {
        result = await executeCommand(
          api,
          request.command,
          prepared,
          isCurrent,
        );
        if (
          request.command.taskPolicy &&
          request.command.subaction === "snapshot"
        ) {
          const binding = bindings.get(request.command.id);
          if (!isCurrent()) throw blocked();
          const installed = await api.scripting.executeScript({
            target: { tabId: Number(request.command.id), frameIds: [0] },
            world: "ISOLATED",
            func: installManualActivity,
            args: [binding.bindingRevision, binding.expiresAt],
          });
          if (!isCurrent()) throw blocked();
          const manualActivity = await activity.read(binding);
          manualActivity.captureGap = installed.some(
            (frame) => frame.result?.captureGap === true,
          );
          if (!isCurrent()) throw blocked();
          for (const frame of result.frames || [])
            if (frame.frameId === 0) frame.manualActivity = manualActivity;
        }
        if (feedback) await new Promise((resolve) => setTimeout(resolve, 150));
      } finally {
        if (feedback) await guidance.cancel(request.id);
      }
      await sender.send({
        type: "result",
        id: request.id,
        ok: true,
        result,
      });
    } catch (error) {
      const reply = {
        type: "result",
        id:
          request?.id ??
          (typeof message?.id === "string" ? message.id : "invalid"),
        ok: false,
        error: {
          kind: error instanceof BridgeError ? error.kind : "UNCERTAIN_OUTCOME",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof BridgeError && error.reason
            ? { reason: error.reason }
            : {}),
        },
      };
      await sender.send(reply);
    }
  }

  const dispatch = (message, sender, isCurrent) => {
    if (message?.type === "protection-owner") {
      if (
        !validId(message.id) ||
        (message.owner !== null && !validId(message.owner)) ||
        Object.keys(message).some(
          (key) => !["type", "id", "owner"].includes(key),
        )
      )
        return Promise.reject(
          new BridgeError(
            "INVALID_REQUEST",
            "Invalid protection account context.",
          ),
        );
      if (!isCurrent()) return Promise.resolve();
      const revision = ++protectionRevision;
      // SetOwner fences the previous account synchronously, before any page update.
      const changed = protectionAdvisory
        ? protectionAdvisory.setOwner(message.owner)
        : Promise.reject(
            new BridgeError("UNSUPPORTED", "Website advice is not enabled."),
          );
      return changed
        .then((result) => {
          if (!isCurrent() || revision !== protectionRevision)
            throw new BridgeError(
              "STALE_REF",
              "Protection account context changed.",
            );
          return sender.send({
            type: "result",
            id: message.id,
            ok: true,
            result,
          });
        })
        .catch((error) =>
          sender.send({
            type: "result",
            id: message.id,
            ok: false,
            error: {
              kind:
                error instanceof BridgeError ? error.kind : "UNCERTAIN_OUTCOME",
              message: "Website advice account context was not confirmed.",
            },
          }),
        );
    }
    if (message?.type === "task-guide") {
      return guidance
        .handle(message, () => isCurrent() && !cancelled.has(message.id))
        .then(
          (result) =>
            sender.send({ type: "result", id: message.id, ok: true, result }),
          (error) =>
            sender.send({
              type: "result",
              id: message.id || "invalid",
              ok: false,
              error: {
                kind:
                  error instanceof BridgeError
                    ? error.kind
                    : "UNCERTAIN_OUTCOME",
                message: "Task guidance was not displayed.",
              },
            }),
        );
    }
    if (message?.type === "task-bind") {
      const bound = bindingQueue.then(async () => {
        const result = await bind(message, isCurrent);
        await sender.send({ type: "result", id: message.id, ok: true, result });
      });
      bindingQueue = bound.catch(() => {});
      return bound.catch((error) =>
        sender.send({
          type: "result",
          id: message.id || "invalid",
          ok: false,
          error: {
            kind: error instanceof BridgeError ? error.kind : "POLICY_BLOCKED",
            message: "Task binding was not activated.",
          },
        }),
      );
    }
    if (message?.type === "cancel") {
      if (
        typeof message.id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(message.id) ||
        Object.keys(message).some((key) => !["type", "id"].includes(key))
      ) {
        return Promise.reject(
          new BridgeError("INVALID_REQUEST", "Invalid cancellation identity."),
        );
      }
      if (!isCurrent()) return Promise.resolve();
      // In-memory fencing occurs synchronously, even while persistence is pending.
      cancelled.add(message.id);
      return Promise.all([
        guidance.cancel(message.id),
        api.storage.local.set({ [`request:${message.id}`]: "cancelled" }),
      ]);
    }
    processing = processing.then(() => handle(message, sender, isCurrent));
    const admitted = processing;
    processing = processing.catch(() => {});
    return admitted;
  };
  // Called only by the generated worker composition, never by a website message.
  dispatch.attachProtectionAdvisory = (advisory) => {
    if (protectionAdvisory) throw Error("Website advice is already attached");
    protectionAdvisory = advisory;
  };
  dispatch.hasProtectionAdvisory = () => protectionAdvisory !== null;
  dispatch.recordManualActivity = (message, sender) =>
    activity.record(message, sender);
  dispatch.answerGuide = (message, sender) => guidance.answer(message, sender);
  dispatch.dismissGuide = (message, sender) =>
    guidance.dismiss(message, sender);
  dispatch.disconnect = () => {
    protectionRevision++;
    const retired = protectionAdvisory?.setOwner(null);
    for (const [tabId, binding] of bindings)
      bindings.set(tabId, { ...binding, revoked: true });
    return Promise.all([retired, guidance.clearAll()]);
  };
  dispatch.recover = async () => {
    await dispatch.disconnect();
    await guidance.recover();
  };
  return dispatch;
}
