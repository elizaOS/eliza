/** Runs only in a native-owned isolated world, never in the website world. */
export function installControlChannel(pageCommand) {
  if (window !== window.top || !/^https?:$/.test(location.protocol)) return;
  const channel = globalThis.elizaSurfaceControl;
  // randomUUID requires a secure context; getRandomValues also works on HTTP
  // pages. The identifier is an opaque document reference, never a credential.
  const identifier = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  let documentId = identifier();
  let active = true;
  let sequence = 0;
  const send = (value) => channel.postMessage(JSON.stringify(value));
  channel.onmessage = (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!request || typeof request !== "object") return;
    const reply = (result) =>
      send({ documentId, sequence: request.sequence, result });
    const reject = (kind, message) => reply({ error: { kind, message } });
    if (
      !active ||
      request.documentId !== documentId ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence <= sequence
    ) {
      reject(
        "STALE_REF",
        "The document or command sequence is no longer current.",
      );
      return;
    }
    // Consume before execution. A lost reply must never replay an effect.
    sequence = request.sequence;
    const command = request.command;
    if (
      !command ||
      !["snapshot", "click", "fill", "scroll"].includes(command.subaction)
    ) {
      reject("UNSUPPORTED", "This channel accepts fixed page commands only.");
      return;
    }
    if (command.subaction !== "snapshot" && !command.taskPolicy) {
      reject("POLICY_BLOCKED", "An effect requires a host-issued task policy.");
      return;
    }
    const policy = command.taskPolicy;
    if (
      (command.subaction === "fill" && typeof command.text !== "string") ||
      (command.subaction === "scroll" &&
        !["up", "down", "left", "right"].includes(command.direction)) ||
      (policy &&
        (typeof policy.origin !== "string" ||
          !Number.isSafeInteger(policy.expiresAt) ||
          !Array.isArray(policy.targets) ||
          !policy.targets.every(
            (target) =>
              target &&
              typeof target.selector === "string" &&
              ["click", "fill", "scroll"].includes(target.action),
          )))
    ) {
      reject(
        "INVALID_REQUEST",
        "The command or host task policy is malformed.",
      );
      return;
    }
    try {
      const snapshotId = command.subaction === "snapshot" ? identifier() : null;
      const result = pageCommand(command, snapshotId);
      reply(snapshotId && !result.error ? { ...result, snapshotId } : result);
    } catch {
      // Do not echo exception text: page values may be present in it. An
      // effect can have run before an exception, so the host must read back.
      reject(
        command.subaction === "snapshot" ? "UNAVAILABLE" : "UNCERTAIN_OUTCOME",
        "The page command did not return a result; observe before continuing.",
      );
    }
  };
  const ready = () => send({ ready: true, documentId });
  window.addEventListener("pagehide", (event) => {
    if (event.isTrusted) active = false;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.isTrusted) return;
    active = true;
    // A restored back/forward-cache document must not revive old commands.
    if (event.persisted) documentId = identifier();
    ready();
  });
  ready();
  // Android may deliver the document-start message before its navigation
  // callback. Announce again once the DOM has loaded, retaining the same ID.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ready, { once: true });
}
