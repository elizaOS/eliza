/** Durable, value-free form-submission attempts from the bound main frame. */
import { BridgeError } from "./protocol.mjs";

export function createManualActivity(api, getBinding) {
  let queue = Promise.resolve();
  const identity = (b) =>
    JSON.stringify([b.actorId, b.accountId, b.agentId, b.taskId]);
  const storageKey = (b) => `manual-activity:${identity(b)}`;
  const fail = () => {
    throw new BridgeError(
      "POLICY_BLOCKED",
      "Manual activity does not match an active main-frame task.",
    );
  };
  return {
    record(message, sender) {
      const work = queue.then(async () => {
        const binding = getBinding(String(sender?.tab?.id));
        if (
          !binding ||
          binding.revoked ||
          binding.expiresAt <= Date.now() ||
          sender.id !== api.runtime.id ||
          sender.frameId !== 0 ||
          typeof sender.documentId !== "string" ||
          !sender.documentId ||
          sender.documentId.length > 256
        )
          fail();
        if (
          !message ||
          ![
            "bindingRevision,eventId,kind,type",
            "bindingRevision,credential,eventId,kind,type",
          ].includes(Object.keys(message).sort().join(",")) ||
          (message.credential !== undefined && message.credential !== true) ||
          message.type !== "task-manual-activity" ||
          message.kind !== "form-submit" ||
          !/^[a-f0-9-]{36}$/.test(message.eventId) ||
          message.bindingRevision !== binding.bindingRevision ||
          new URL(sender.url).origin !== binding.origin
        )
          fail();
        const key = storageKey(binding);
        const saved = (await api.storage.local.get(key))[key] || {
          events: [],
          overflow: false,
        };
        if (
          getBinding(binding.tabId) !== binding ||
          binding.expiresAt <= Date.now()
        )
          fail();
        if (saved.events.some((event) => event.eventId === message.eventId))
          return { recorded: true };
        // Never silently discard old evidence. Overflow is persistent and explicit.
        if (saved.events.length >= 256) saved.overflow = true;
        else
          saved.events.push({
            eventId: message.eventId,
            kind: "form-submit",
            documentId: sender.documentId,
            origin: binding.origin,
            epoch: binding.epoch,
            observedAt: Date.now(),
            // A sign-in or code form; never proof of what else was sent.
            ...(message.credential ? { credential: true } : {}),
          });
        await api.storage.local.set({ [key]: saved });
        return { recorded: !saved.overflow, overflow: saved.overflow };
      });
      queue = work.catch(() => {});
      return work;
    },
    async read(binding) {
      await queue;
      const result = (await api.storage.local.get(storageKey(binding)))[
        storageKey(binding)
      ] || { events: [], overflow: false };
      return structuredClone(result);
    },
  };
}

/** Fixed isolated-world listener. No form values, labels, URLs or target selectors. */
export function installManualActivity(bindingRevision, expiresAt) {
  const key = "__elizaManualActivityV1";
  const captureGap = globalThis[key]?.failed === true;
  if (globalThis[key]) globalThis[key].abort();
  const controller = new AbortController();
  controller.failed = captureGap;
  globalThis[key] = controller;
  let activatedAt = -Infinity;
  const activated = (event) => {
    if (event.isTrusted) activatedAt = performance.now();
  };
  const options = { capture: true, signal: controller.signal };
  document.addEventListener("click", activated, options);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " ") activated(event);
    },
    options,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (
        !event.isTrusted ||
        performance.now() - activatedAt > 1500 ||
        Date.now() >= expiresAt
      )
        return;
      // This proves only a form submit event associated with recent human input.
      // The website may preventDefault, fail its request, or submit different data.
      // A form with a password, code or user-name field is marked as a sign-in
      // form; only that fact leaves the page, never a field or its value.
      const form = event.target;
      const credential =
        form instanceof HTMLFormElement &&
        [...form.elements].some(
          (field) =>
            field instanceof HTMLInputElement &&
            (field.type === "password" ||
              /(?:^|\s)(?:username|current-password|new-password|one-time-code|webauthn)(?:\s|$)/i.test(
                field.autocomplete || field.getAttribute("autocomplete") || "",
              )),
        );
      try {
        void chrome.runtime
          .sendMessage({
            type: "task-manual-activity",
            kind: "form-submit",
            eventId: crypto.randomUUID(),
            bindingRevision,
            ...(credential ? { credential: true } : {}),
          })
          .then(
            (reply) => {
              // A lost sign-in form is not payment evidence; it is no gap.
              if (!reply?.recorded && !credential) controller.failed = true;
            },
            () => {
              if (!credential) controller.failed = true;
            },
          );
      } catch {
        if (!credential) controller.failed = true;
      }
    },
    options,
  );
  return { installed: true, captureGap };
}
