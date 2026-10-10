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

  async function request(operation, value) {
    if (operation === "write" && typeof value !== "string")
      throw new TypeError("Credential value must be a string");
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
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Broker rejected request");
      }
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid broker response");
      if (operation === "read") {
        if (
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, "value") ||
          (body.value !== null && typeof body.value !== "string")
        )
          throw new Error("Invalid broker read response");
        return body.value;
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
