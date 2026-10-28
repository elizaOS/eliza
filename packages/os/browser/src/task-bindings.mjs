/** Shared task authority for trusted browser transports. No page input runs here. */
import { BridgeError } from "./protocol.mjs";

/** Longest life of a consented-commit grant, from the host's yes to its use. */
export const COMMIT_GRANT_MAX_MS = 60000;

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
  const exactOrigin = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  };
  // A task the host extended to more websites binds all of them at once; each
  // command is still scoped to the origin of the page it reads or acts on.
  const originsOf = (binding) => binding.origins ?? [binding.origin];
  const grantKey = (id) => `commit-grant:${id}`;
  // Grants spent in this lifetime. Storage keeps them across a worker restart.
  const spentGrants = new Set();
  const grantKeys = [
    "grantId",
    "taskId",
    "epoch",
    "origin",
    "targetRef",
    "selector",
    "subaction",
    "valueHash",
    "requestTarget",
    "formHash",
    "expiresAt",
  ];
  // The one request a commit may send besides its form's own page load:
  // exactly one of an absolute https `url` or a `path` on the page's origin,
  // and its method. Same shape as validCommitRequestTarget in plugin-browser.
  const validRequestTarget = (target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).some(
        (key) => !["url", "path", "method"].includes(key),
      ) ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(target.method) ||
      "url" in target === "path" in target
    )
      return false;
    if ("path" in target)
      return (
        typeof target.path === "string" &&
        target.path.length <= 2048 &&
        /^\/(?!\/)[^\s#\\]*$/.test(target.path)
      );
    if (typeof target.url !== "string" || target.url.length > 2048)
      return false;
    try {
      const url = new URL(target.url);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !target.url.includes("#")
      );
    } catch {
      return false;
    }
  };
  const sha256 = async (text) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
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
            "origins",
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
          ![
            "click",
            "fill",
            "fill-code",
            "select",
            "scroll",
            "follow",
          ].includes(target.action),
      )
    )
      throw blocked();
    if (
      !exactOrigin(binding.origin) ||
      (binding.origins !== undefined &&
        (!Array.isArray(binding.origins) ||
          binding.origins.length < 2 ||
          binding.origins.length > 16 ||
          !binding.origins.every(exactOrigin) ||
          new Set(binding.origins).size !== binding.origins.length ||
          !binding.origins.includes(binding.origin)))
    )
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
      JSON.stringify(binding.origins) === JSON.stringify(previous.origins) &&
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
        !["click", "fill", "select", "scroll", "follow"].includes(
          command.subaction,
        ))
    )
      throw blocked();
    // A consented commit names the one reviewed control it is for.
    if (
      command.commitGrant !== undefined &&
      (!command.taskContext ||
        command.expectedSelector === undefined ||
        !["click", "fill", "select"].includes(command.subaction))
    )
      throw blocked();
    delete copy.taskPolicy;
    delete copy.expectedSelector;
    delete copy.commitGrant;
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
      ![
        "snapshot",
        "click",
        "fill",
        "select",
        "scroll",
        "follow",
        "navigate",
      ].includes(command.subaction)
    )
      throw blocked();
    // Removal has no page-read/action authority. It still belongs to exactly
    // this in-memory binding, but may clean up after expiry or navigation.
    let origin = binding.origin;
    if (!cleanup) {
      origin = new URL(await getUrl(command.id)).origin;
      if (!current() || !originsOf(binding).includes(origin)) throw blocked();
    }
    if (
      command.subaction === "navigate" &&
      !originsOf(binding).includes(new URL(command.url).origin)
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
    const commitGrant =
      command.commitGrant === undefined
        ? undefined
        : await spendCommitGrant(command, binding, current, origin);
    copy.taskPolicy = {
      origin,
      targets: binding.targets,
      ...(command.expectedSelector === undefined
        ? {}
        : { expectedSelector: command.expectedSelector }),
      expiresAt,
      guidanceScope: String(binding.bindingRevision),
      protectedValueKind: command.protectedValueKind,
      assistantName: binding.assistantName,
      ...(commitGrant === undefined ? {} : { commitGrant }),
    };
    return { command: copy, current };
  }
  /**
   * A host-issued grant for one commit the person said yes to: this task and
   * epoch, this origin, this control in this observation and, for a fill or
   * select, this exact value; optionally the one request it may send
   * (requestTarget) and the form data she saw (formHash). It is spent here, once, before the page sees it; a refusal
   * after this point still spends it. Without a grant, commits stay blocked.
   */
  async function spendCommitGrant(command, binding, current, pageOrigin) {
    const grant = command.commitGrant;
    if (
      !grant ||
      typeof grant !== "object" ||
      Array.isArray(grant) ||
      Object.keys(grant).some((key) => !grantKeys.includes(key)) ||
      !validId(grant.grantId) ||
      grant.taskId !== binding.taskId ||
      grant.epoch !== binding.epoch ||
      // The origin of the page this command acts on, which an extended task
      // may have moved to; a grant for one origin never commits on another.
      grant.origin !== pageOrigin ||
      grant.subaction !== command.subaction ||
      grant.targetRef !== command.selector ||
      typeof grant.targetRef !== "string" ||
      grant.selector !== command.expectedSelector ||
      !binding.targets.some(
        (target) =>
          target.selector === grant.selector &&
          (target.action === command.subaction ||
            (target.action === "fill-code" && command.subaction === "fill")),
      ) ||
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= now() ||
      grant.expiresAt > now() + COMMIT_GRANT_MAX_MS ||
      // A click carries no value; a fill or select commits only the exact
      // text the person approved, so it must name that text's hash.
      (command.subaction === "click"
        ? grant.valueHash !== undefined
        : typeof grant.valueHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(grant.valueHash) ||
          typeof command.text !== "string") ||
      (grant.requestTarget !== undefined &&
        !validRequestTarget(grant.requestTarget)) ||
      (grant.formHash !== undefined &&
        (typeof grant.formHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(grant.formHash)))
    )
      throw blocked();
    if (
      command.subaction !== "click" &&
      (await sha256(command.text)) !== grant.valueHash
    )
      throw blocked();
    const requestTarget =
      grant.requestTarget === undefined
        ? undefined
        : "url" in grant.requestTarget
          ? { url: grant.requestTarget.url, method: grant.requestTarget.method }
          : {
              path: grant.requestTarget.path,
              method: grant.requestTarget.method,
            };
    const key = grantKey(grant.grantId);
    if (spentGrants.has(grant.grantId) || (await read(key)) || !current())
      throw blocked();
    // Spend in memory before awaiting storage, so a concurrent copy fails.
    if (spentGrants.has(grant.grantId)) throw blocked();
    spentGrants.add(grant.grantId);
    await write(key, {
      taskId: grant.taskId,
      epoch: grant.epoch,
      origin: grant.origin,
      targetRef: grant.targetRef,
      selector: grant.selector,
      subaction: grant.subaction,
      ...(requestTarget === undefined ? {} : { requestTarget }),
      ...(grant.formHash === undefined ? {} : { formHash: grant.formHash }),
      expiresAt: grant.expiresAt,
      spentAt: now(),
    });
    if (!current() || grant.expiresAt <= now()) throw blocked();
    // The request and form contents the person said yes to travel with the
    // grant, so the page consents only that request with that form data.
    return {
      grantId: grant.grantId,
      selector: grant.selector,
      ...(requestTarget === undefined ? {} : { requestTarget }),
      ...(grant.formHash === undefined ? {} : { formHash: grant.formHash }),
      expiresAt: grant.expiresAt,
    };
  }
  return { bind, scope, blocked, validId };
}
