/** Durable, value-free form-submission attempts from the bound main frame. */
import { BridgeError } from "./protocol.mjs";

/**
 * `getBinding(tabId)` is the tab's live binding; while a rebind of the tab is
 * in flight it is the binding being replaced. `settled(tabId)` resolves once
 * no rebind of the tab is in flight.
 */
export function createManualActivity(
  api,
  getBinding,
  settled = async () => {},
) {
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
      // The binding when the submit arrives. A submit that opens a page can
      // lead the host to bind the next page before this queued write runs;
      // the event still belongs to the epoch the person submitted under.
      const binding = getBinding(String(sender?.tab?.id));
      const receivedAt = Date.now();
      const work = queue.then(async () => {
        let origin;
        try {
          origin = new URL(sender?.url).origin;
        } catch {
          fail();
        }
        if (
          !binding ||
          binding.revoked ||
          binding.expiresAt <= receivedAt ||
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
          // A task the host extended (a sign-in hand-off) binds each of its
          // origins; the event records the origin the form was submitted on.
          !(binding.origins ?? [binding.origin]).includes(origin)
        )
          fail();
        const key = storageKey(binding);
        const saved = (await api.storage.local.get(key))[key] || {
          events: [],
          overflow: false,
        };
        // A rebind of the same task (a renewal or a new epoch) keeps the
        // event; another task on the tab, or a revocation, refuses it. A
        // rebind still in flight is decided once it lands.
        await settled(binding.tabId);
        const current = getBinding(binding.tabId);
        if (
          !current ||
          current.revoked ||
          identity(current) !== identity(binding)
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
            origin,
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
  // Submits the worker refused or that could not be sent, by event ID, so
  // each new failure is told apart from one already reported.
  const refused = [...(globalThis[key]?.refused ?? [])];
  // Submits whose reply was lost. A submit that opens a page closes the
  // message channel before the reply arrives, though the worker received and
  // recorded the event. The worker checks each ID against its journal.
  const unconfirmed = [...(globalThis[key]?.unconfirmed ?? [])];
  if (globalThis[key]) globalThis[key].abort();
  const controller = new AbortController();
  controller.refused = new Set(refused);
  controller.unconfirmed = new Set(unconfirmed);
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
      const eventId = crypto.randomUUID();
      try {
        // Sent while the document is still current, so the worker records it
        // with this binding's epoch even when the submit replaces the page.
        const sent = chrome.runtime.sendMessage({
          type: "task-manual-activity",
          kind: "form-submit",
          eventId,
          bindingRevision,
          ...(credential ? { credential: true } : {}),
        });
        controller.unconfirmed.add(eventId);
        void sent.then(
          (reply) => {
            controller.unconfirmed.delete(eventId);
            // A credential field describes the form, not its effects.
            // A refused event remains a gap in the observed activity.
            if (!reply?.recorded) controller.refused.add(eventId);
          },
          // A lost reply stays unconfirmed: only the journal can say whether
          // the event arrived. A missing event is reported as a gap.
          () => {},
        );
      } catch {
        controller.unconfirmed.delete(eventId);
        controller.refused.add(eventId);
      }
    },
    options,
  );
  return {
    installed: true,
    captureGap: refused.length > 0,
    refused,
    unconfirmed,
  };
}
