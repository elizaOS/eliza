/** Private process-to-process client for LocalCredentialBroker; never expose to a renderer. */
export class LocalCredentialBrokerError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalCredentialBrokerError";
    this.code = "CREDENTIAL_BROKER_UNAVAILABLE";
  }
}

function createCredentialStore(
  {
    port,
    token,
    timeoutMs,
    unavailableMessage = "Local credential storage unavailable",
  },
  prefix,
  taskKeys = false,
  verifiedAccount = false,
) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof token !== "string" ||
    !token ||
    /\s/.test(token) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2147483647 ||
    typeof unavailableMessage !== "string" ||
    !unavailableMessage
  )
    throw new TypeError("Invalid local credential broker configuration");

  async function request(operation, value, expected) {
    if (
      verifiedAccount &&
      operation === "exchange" &&
      [value, expected].some((v) => v !== null && typeof v !== "string")
    )
      throw new TypeError("Verified account snapshots must be strings or null");
    if (operation === "write" && typeof value !== "string")
      throw new TypeError("Credential value must be a string");
    if (
      taskKeys &&
      operation === "remove" &&
      (typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          value,
        ))
    )
      throw new TypeError("Invalid task key generation");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/credential`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          operation: `${prefix}${operation}`,
          ...(value === undefined ? {} : { value }),
          ...(expected === undefined ? {} : { expected }),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Broker rejected request");
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid broker response");
      if (verifiedAccount && operation === "exchange") {
        if (
          Object.keys(body).length !== 1 ||
          typeof body.exchanged !== "boolean"
        )
          throw new Error("Invalid verified account acknowledgement");
        return body.exchanged;
      }
      if (taskKeys && operation === "remove") {
        if (Object.keys(body).length !== 1 || typeof body.removed !== "boolean")
          throw new Error("Invalid task key acknowledgement");
        return body.removed;
      }
      if (operation === "read" || (taskKeys && operation === "create")) {
        if (
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, "value") ||
          (body.value !== null && typeof body.value !== "string")
        )
          throw new Error("Invalid broker read response");
        if (!taskKeys) return body.value;
        if (body.value === null && operation === "read") return null;
        const record = JSON.parse(body.value);
        if (
          !record ||
          Object.keys(record).length !== 3 ||
          record.version !== 1 ||
          typeof record.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            record.id,
          ) ||
          typeof record.key !== "string" ||
          !/^[A-Za-z0-9+/]{43}=$/.test(record.key)
        )
          throw new Error("Invalid task key response");
        const bytes = Uint8Array.from(atob(record.key), (c) => c.charCodeAt(0));
        if (
          bytes.length !== 32 ||
          btoa(String.fromCharCode(...bytes)) !== record.key
        ) {
          bytes.fill(0);
          throw new Error("Invalid task key bytes");
        }
        return { id: record.id, bytes };
      }
      if (Object.keys(body).length)
        throw new Error("Invalid broker acknowledgement");
      return null;
    } catch {
      // Never include server bodies, credentials or underlying fetch diagnostics.
      // No retry: a lost write/clear acknowledgement does not prove it was unapplied.
      throw new LocalCredentialBrokerError(unavailableMessage);
    }
  }
  if (verifiedAccount)
    return {
      read: () => request("read"),
      compareExchange: (expected, next) => request("exchange", next, expected),
    };
  if (taskKeys)
    return {
      read: () => request("read"),
      createForNewDatabase: () => request("create"),
      remove: (expectedKeyId) => request("remove", expectedKeyId),
    };
  return {
    read: () => request("read"),
    write: (value) => request("write", value),
    clear: () => request("clear"),
  };
}

/** Primary credential slot; storage identity and custody remain native-host owned. */
export function createLocalCredentialStore(options) {
  return createCredentialStore(options, "");
}

/** Separate pending-enrollment journal; never overwrite the active credential slot. */
export function createLocalPendingCredentialStore(options) {
  return createCredentialStore(options, "pending-");
}

/** Native process only. Identity is fixed by the native broker; wipe returned byte arrays after use. */
export function createLocalTaskDataKeyStore(options) {
  return createCredentialStore(options, "task-key-", true);
}

/** Trusted host only: opaque atomic credential/owner snapshots. No renderer registration. */
export function createLocalVerifiedAccountStore(options) {
  return createCredentialStore(options, "verified-account-", false, true);
}
