/** Shared task authority for trusted browser transports. No page input runs here. */
import { BridgeError } from "./protocol.mjs";

/** Hosts supply storage, page lookup and cleanup; model/page data cannot bind tasks. */
export function createTaskBindings({
  bindings,
  read,
  write,
  clearGuidance,
  getUrl,
  validTabId,
  now = () => Date.now(),
}) {
  const contextKeys = ["actorId", "accountId", "agentId", "taskId", "epoch"];
  const validId = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_.:@-]{1,256}$/.test(value);
  const blocked = () =>
    new BridgeError(
      "POLICY_BLOCKED",
      "The command does not match this tab's active task binding.",
    );
  const bindingKey = (id) => `task-binding:${id}`;
  async function bind(message, current) {
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
      !validTabId(binding.tabId) ||
      contextKeys
        .filter((key) => key !== "epoch")
        .some((key) => !validId(binding[key])) ||
      !Number.isSafeInteger(binding.bindingRevision) ||
      binding.bindingRevision < 1 ||
      !Number.isSafeInteger(binding.epoch) ||
      binding.epoch < 0 ||
      !Number.isSafeInteger(binding.expiresAt) ||
      binding.expiresAt <= now() ||
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
          !["click", "fill", "fill-code", "select", "scroll"].includes(
            target.action,
          ),
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
    const previous = bindings.get(binding.tabId) || (await read(key));
    // The host renews an expired lease without changing task authorization.
    // A newer binding revision may do that only for the identical live scope;
    // a revoked binding still needs a new epoch and cannot be revived here.
    const renewal =
      previous &&
      !previous.revoked &&
      !binding.revoked &&
      previous.expiresAt <= now() &&
      contextKeys.every((key) => binding[key] === previous[key]) &&
      binding.origin === previous.origin &&
      binding.assistantName === previous.assistantName &&
      JSON.stringify(binding.targets) === JSON.stringify(previous.targets);
    if (
      !current() ||
      (previous &&
        (binding.bindingRevision <= previous.bindingRevision ||
          (previous.taskId === binding.taskId &&
            (binding.epoch < previous.epoch ||
              (binding.epoch === previous.epoch && !renewal)))))
    )
      throw blocked();
    const next = structuredClone(binding);
    // Fence old work before awaiting storage. Failed persistence leaves the tab
    // blocked; it never restores an older live binding.
    bindings.set(binding.tabId, { ...next, revoked: true });
    await clearGuidance(binding.tabId);
    await write(key, next);
    if (!current()) throw blocked();
    bindings.set(binding.tabId, next);
    return {
      bound: !next.revoked,
      bindingRevision: next.bindingRevision,
      tabId: next.tabId,
      taskId: next.taskId,
      epoch: next.epoch,
    };
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
    if (
      command.expectedSelector !== undefined &&
      (!command.taskContext ||
        !["click", "fill", "select", "scroll"].includes(command.subaction))
    )
      throw blocked();
    delete copy.taskPolicy;
    delete copy.expectedSelector;
    // Only a bound task action carries the host's preview sentence.
    if (!command.taskContext) delete copy.actionText;
    if (!command.id) {
      if (command.taskContext) throw blocked();
      return { command: copy, current: () => true };
    }
    const stored =
      bindings.get(command.id) || (await read(bindingKey(command.id)));
    if (!stored) {
      if (command.taskContext) throw blocked();
      return { command: copy, current: () => true };
    }
    const binding = bindings.get(command.id);
    if (
      command.taskExpiresAt !== undefined &&
      (!Number.isSafeInteger(command.taskExpiresAt) ||
        command.taskExpiresAt <= now())
    )
      throw blocked();
    const expiresAt =
      command.taskExpiresAt === undefined
        ? binding?.expiresAt
        : Math.min(binding?.expiresAt, command.taskExpiresAt);
    const current = () =>
      binding &&
      bindings.get(command.id) === binding &&
      (cleanup || (!binding.revoked && expiresAt > now()));
    if (
      !current() ||
      !command.taskContext ||
      Object.keys(command.taskContext).length !== contextKeys.length ||
      contextKeys.some((key) => command.taskContext[key] !== binding[key])
    )
      throw blocked();
    if (
      !["snapshot", "click", "fill", "select", "scroll", "navigate"].includes(
        command.subaction,
      )
    )
      throw blocked();
    // Removal has no page-read/action authority. It still belongs to exactly
    // this in-memory binding, but may clean up after expiry or navigation.
    if (!cleanup) {
      const url = await getUrl(command.id);
      if (!current() || new URL(url).origin !== binding.origin) throw blocked();
    }
    if (
      command.subaction === "navigate" &&
      new URL(command.url).origin !== binding.origin
    )
      throw blocked();
    if (command.selector && !/^[0-9a-f-]{36}:0:\d+$/.test(command.selector))
      throw blocked();
    // The one reviewed control this action is for. It must be one of this
    // binding's targets; the page then accepts no other target.
    if (
      command.expectedSelector !== undefined &&
      !binding.targets.some(
        (target) => target.selector === command.expectedSelector,
      )
    )
      throw blocked();
    copy.taskPolicy = {
      origin: binding.origin,
      targets: binding.targets,
      ...(command.expectedSelector === undefined
        ? {}
        : { expectedSelector: command.expectedSelector }),
      expiresAt,
      guidanceScope: String(binding.bindingRevision),
      protectedValueKind: command.protectedValueKind,
      assistantName: binding.assistantName,
    };
    return { command: copy, current };
  }
  return { bind, scope, blocked, validId };
}
