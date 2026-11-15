import { randomUUID } from "node:crypto";

/** RAM-only credential custody for one trusted local owner session. Hosts gate
 * calls, serialize effects, cancel pending work on owner changes, and never
 * expose launchKeys() through renderer/model/status routes. Mode is independent
 * of stored keys. No network, filesystem or environment access occurs here. */
export function createProviderKeySession() {
  let mode = "cloud",
    revision = randomUUID(),
    keys = {},
    closed = false;
  const changed = () =>
    Object.assign(
      new Error("Provider settings changed. Refresh and try again."),
      { code: "provider-changed", status: 409 },
    );
  function check(expectedRevision) {
    if (
      closed ||
      typeof expectedRevision !== "string" ||
      expectedRevision !== revision
    )
      throw changed();
  }
  function status() {
    if (closed) throw changed();
    return {
      mode,
      revision,
      keys: {
        text: { configured: typeof keys.text === "string" },
        voice: { configured: typeof keys.voice === "string" },
      },
      persistence: "host-session",
    };
  }
  function keyName(key) {
    if (key !== "text" && key !== "voice")
      throw new Error("Invalid provider key.");
    return key;
  }
  function edit(input) {
    check(input?.expectedRevision);
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["expectedRevision", "textKey", "voiceKey"].includes(k),
      ) ||
      !["textKey", "voiceKey"].some((k) => Object.hasOwn(input, k))
    )
      throw new Error("Choose a provider key to edit.");
    const next = { ...keys };
    for (const [field, key] of [
      ["textKey", "text"],
      ["voiceKey", "voice"],
    ])
      if (Object.hasOwn(input, field)) {
        if (
          typeof input[field] !== "string" ||
          !/^[!-~]{8,1024}$/.test(input[field])
        )
          throw new Error("Enter a valid provider key.");
        next[key] = input[field];
      }
    keys = next;
    revision = randomUUID();
    return status();
  }
  return {
    status,
    check,
    edit,
    select(input) {
      check(input?.expectedRevision);
      if (!["cloud", "own"].includes(input.mode))
        throw new Error("Invalid provider mode.");
      if (input.mode === "own" && !keys.text)
        throw new Error("Add a Text key before selecting Own.");
      mode = input.mode;
      revision = randomUUID();
      return status();
    },
    remove(input) {
      check(input?.expectedRevision);
      delete keys[keyName(input.key)];
      revision = randomUUID();
      return status();
    },
    reveal(input) {
      check(input?.expectedRevision);
      const key = keyName(input.key),
        value = keys[key];
      if (!value) throw new Error("Provider key is not saved.");
      return { key, value, revision };
    },
    launchKeys() {
      if (closed) throw changed();
      return mode === "own"
        ? { apiKey: keys.text, cartesiaKey: keys.voice, revision }
        : null;
    },
    invalidate() {
      if (!closed) revision = randomUUID();
    },
    close() {
      keys = {};
      closed = true;
      revision = randomUUID();
    },
  };
}
