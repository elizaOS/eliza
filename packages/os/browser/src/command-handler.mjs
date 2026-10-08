/** Consumes native requests once; cancellation bypasses the command queue. */
import { executeCommand, prepareCommand } from "./commands.mjs";
import {
  createManualActivity,
  installManualActivity,
} from "./manual-activity.mjs";
import { BridgeError, parseCommand } from "./protocol.mjs";
import { createTaskGuidance } from "./task-guidance.mjs";

export function createCommandHandler(api) {
  const cancelled = new Set();
  const bindings = new Map();
  const activity = createManualActivity(api, (tabId) => bindings.get(tabId));
  let bindingQueue = Promise.resolve();
  const guidance = createTaskGuidance(api, scope);
  const contextKeys = ["actorId", "accountId", "agentId", "taskId", "epoch"];
  const validId = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,256}$/.test(value);
  const blocked = () =>
    new BridgeError(
      "POLICY_BLOCKED",
      "The command does not match this tab's active task binding.",
    );
  const bindingKey = (id) => `task-binding:${id}`;
  async function bind(message, sender, current) {
    const { id, binding } = message;
    if (
      !validId(id) ||
      !binding ||
      typeof binding !== "object" ||
      Object.keys(message).some(
        (key) => !["type", "id", "binding"].includes(key),
      ) ||
      Object.keys(binding).some(
        (key) =>
          ![
            "tabId",
            "bindingRevision",
            ...contextKeys,
            "origin",
            "expiresAt",
            "targets",
            "revoked",
            "assistantName",
          ].includes(key),
      ) ||
      // Display name for the overlay cursor and marks; host configuration.
      (binding.assistantName !== undefined &&
        (typeof binding.assistantName !== "string" ||
          !/^[^\p{Cc}\p{Cf}]{1,32}$/u.test(binding.assistantName) ||
          !binding.assistantName.trim())) ||
      typeof binding.tabId !== "string" ||
      !/^\d+$/.test(binding.tabId) ||
      !Number.isSafeInteger(Number(binding.tabId)) ||
      contextKeys
        .filter((key) => key !== "epoch")
        .some((key) => !validId(binding[key])) ||
      !Number.isSafeInteger(binding.bindingRevision) ||
      binding.bindingRevision < 1 ||
      !Number.isSafeInteger(binding.epoch) ||
      binding.epoch < 0 ||
      !Number.isSafeInteger(binding.expiresAt) ||
      binding.expiresAt <= Date.now() ||
      typeof binding.revoked !== "boolean" ||
      !Array.isArray(binding.targets) ||
      binding.targets.length > 64 ||
      binding.targets.some(
        (target) =>
          !target ||
          Object.keys(target).some(
            (key) => !["selector", "action"].includes(key),
          ) ||
          typeof target.selector !== "string" ||
          !target.selector ||
          target.selector.length > 256 ||
          !["click", "fill", "fill-code", "scroll"].includes(target.action),
      )
    )
      throw blocked();
    let origin;
    try {
      origin = new URL(binding.origin);
    } catch {
      throw blocked();
    }
    if (origin.protocol !== "https:" || origin.origin !== binding.origin)
      throw blocked();
    if (!current()) throw blocked();
    const key = bindingKey(binding.tabId);
    const previous =
      bindings.get(binding.tabId) || (await api.storage.local.get(key))[key];
    if (
      !current() ||
      (previous &&
        (binding.bindingRevision <= previous.bindingRevision ||
          (previous.taskId === binding.taskId &&
            binding.epoch <= previous.epoch)))
    )
      throw blocked();
    const next = structuredClone(binding);
    // Fence old work before awaiting storage. Failed persistence leaves the tab
    // blocked; it never restores an older live binding.
    bindings.set(binding.tabId, { ...next, revoked: true });
    await guidance.clearTab(binding.tabId);
    await api.storage.local.set({ [key]: next });
    if (!current()) throw blocked();
    bindings.set(binding.tabId, next);
    await sender.send({
      type: "result",
      id,
      ok: true,
      result: {
        bound: !next.revoked,
        bindingRevision: next.bindingRevision,
        tabId: next.tabId,
        taskId: next.taskId,
        epoch: next.epoch,
      },
    });
  }
  async function scope(command, cleanup = false) {
    const copy = { ...command };
    if (
      command.protectedValueKind !== undefined &&
      (command.protectedValueKind !== "verification-code" ||
        command.subaction !== "fill" ||
        !command.taskContext)
    )
      throw blocked();
    delete copy.taskPolicy;
    if (!command.id) {
      if (command.taskContext) throw blocked();
      return { command: copy, current: () => true };
    }
    const stored =
      bindings.get(command.id) ||
      (await api.storage.local.get(bindingKey(command.id)))[
        bindingKey(command.id)
      ];
    if (!stored) {
      if (command.taskContext) throw blocked();
      return { command: copy, current: () => true };
    }
    const binding = bindings.get(command.id);
    if (
      command.taskExpiresAt !== undefined &&
      (!Number.isSafeInteger(command.taskExpiresAt) ||
        command.taskExpiresAt <= Date.now())
    )
      throw blocked();
    const expiresAt =
      command.taskExpiresAt === undefined
        ? binding?.expiresAt
        : Math.min(binding?.expiresAt, command.taskExpiresAt);
    const current = () =>
      binding &&
      bindings.get(command.id) === binding &&
      (cleanup || (!binding.revoked && expiresAt > Date.now()));
    if (
      !current() ||
      !command.taskContext ||
      Object.keys(command.taskContext).length !== contextKeys.length ||
      contextKeys.some((key) => command.taskContext[key] !== binding[key])
    )
      throw blocked();
    if (
      !["snapshot", "click", "fill", "scroll", "navigate"].includes(
        command.subaction,
      )
    )
      throw blocked();
    // Removal has no page-read/action authority. It still belongs to exactly
    // this in-memory binding, but may clean up after expiry or navigation.
    if (!cleanup) {
      const tab = await api.tabs.get(Number(command.id));
      if (!current() || new URL(tab.url).origin !== binding.origin)
        throw blocked();
    }
    if (
      command.subaction === "navigate" &&
      new URL(command.url).origin !== binding.origin
    )
      throw blocked();
    if (command.selector && !/^[0-9a-f-]{36}:0:\d+$/.test(command.selector))
      throw blocked();
    copy.taskPolicy = {
      origin: binding.origin,
      targets: binding.targets,
      expiresAt,
      guidanceScope: String(binding.bindingRevision),
      protectedValueKind: command.protectedValueKind,
      assistantName: binding.assistantName,
    };
    return { command: copy, current };
  }
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
        ["click", "fill", "scroll"].includes(request.command.subaction)
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
        },
      };
      await sender.send(reply);
    }
  }

  const dispatch = (message, sender, isCurrent) => {
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
      const bound = bindingQueue.then(() => bind(message, sender, isCurrent));
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
  dispatch.recordManualActivity = (message, sender) =>
    activity.record(message, sender);
  dispatch.answerGuide = (message, sender) => guidance.answer(message, sender);
  dispatch.disconnect = () => {
    for (const [tabId, binding] of bindings)
      bindings.set(tabId, { ...binding, revoked: true });
    return guidance.clearAll();
  };
  dispatch.recover = async () => {
    await dispatch.disconnect();
    await guidance.recover();
  };
  return dispatch;
}
