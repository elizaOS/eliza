/** Private diagnostic correlation only. No request, identity, or provider data. */
export type ManagedGoogleFailureStage =
  | "credential"
  | "signal"
  | "client"
  | "identity"
  | "accounts"
  | "account-projection"
  | "credential-recheck"
  | "permission-recheck"
  | "calendar-sources"
  | "request-validation"
  | "fetch"
  | "response-json";
const stages = new WeakMap<object, ManagedGoogleFailureStage>();
export function recordManagedGoogleFailure(
  error: unknown,
  stage: ManagedGoogleFailureStage,
): void {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    !stages.has(error)
  )
    stages.set(error, stage);
}
export function managedGoogleFailureStage(
  error: unknown,
): ManagedGoogleFailureStage | undefined {
  return error !== null &&
    (typeof error === "object" || typeof error === "function")
    ? stages.get(error)
    : undefined;
}
/** Exact transport constants only; never serialize error/cause objects or messages. */
const transportCodes = [
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_THIS",
  "ERR_INVALID_URL",
  "ERR_UNESCAPED_CHARACTERS",
  "ERR_PROXY_TUNNEL",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ConnectionRefused",
  "ConnectionClosed",
  "Timeout",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_SIGNATURE_FAILURE",
] as const;
export type ManagedGoogleTransportCode = (typeof transportCodes)[number];
const allowedTransportCodes = new Set<string>(transportCodes);
function ownData(value: unknown, key: "code" | "cause" | "message"): unknown {
  try {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && "value" in property ? property.value : undefined;
  } catch {
    return;
  }
}
/** Finite diagnostic labels only. Unknown/oversized/accessor text is omitted. */
export type ManagedGoogleTransportMessageFamily =
  | "redirect-refused"
  | "certificate"
  | "tls"
  | "invalid-url-or-arguments"
  | "connection"
  | "generic-fetch";
function transportMessageFamily(
  error: unknown,
): ManagedGoogleTransportMessageFamily | undefined {
  const message = ownData(error, "message");
  if (typeof message !== "string" || message.length > 512) return;
  if (
    /^(?:UnexpectedRedirect|Unexpected redirect|unexpected redirect|redirect count exceeded|Redirect mode is set to error|Fetch failed: Encountered redirect while redirect mode is set to 'error')\.?$/.test(
      message,
    )
  )
    return "redirect-refused";
  if (
    /^(?:certificate (?:verify failed|has expired|is not yet valid)|self[- ]signed certificate(?: in certificate chain)?|unable to (?:get local issuer certificate|verify the first certificate|verify leaf signature)|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)$/i.test(
      message,
    )
  )
    return "certificate";
  if (
    /^(?:TLS handshake failed|SSL handshake failed|SSL connection failed|wrong version number|ERR_SSL_WRONG_VERSION_NUMBER|ERR_SSL_PROTOCOL_ERROR)$/i.test(
      message,
    )
  )
    return "tls";
  if (
    /^(?:Invalid URL|Invalid url|invalid URL|ERR_INVALID_URL|Illegal invocation)$/.test(
      message,
    ) ||
    /^Failed to (?:parse URL from [^\r\n]*|construct 'Request': Invalid URL [^\r\n]*)$/.test(
      message,
    ) ||
    /^The "[a-zA-Z][a-zA-Z0-9_.]*" argument must be [^\r\n]+$/.test(message)
  )
    return "invalid-url-or-arguments";
  if (
    message === "Unable to connect. Is the computer able to access the url?" ||
    message ===
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
  )
    return "connection";
  if (
    /^(?:fetch failed|Fetch failed|Failed to fetch|fetch\(\) failed|Network request failed|Load failed)$/.test(
      message,
    )
  )
    return "generic-fetch";
  return;
}
export function managedGoogleTransportCodes(error: unknown): {
  transportCode?: ManagedGoogleTransportCode;
  causeTransportCode?: ManagedGoogleTransportCode;
  transportMessageFamily?: ManagedGoogleTransportMessageFamily;
  causeTransportMessageFamily?: ManagedGoogleTransportMessageFamily;
} {
  const cause = ownData(error, "cause"),
    code = ownData(error, "code"),
    causeCode = ownData(cause, "code");
  const family = transportMessageFamily(error),
    causeFamily = transportMessageFamily(cause);
  return {
    ...(family ? { transportMessageFamily: family } : {}),
    ...(causeFamily ? { causeTransportMessageFamily: causeFamily } : {}),
    ...(typeof code === "string" && allowedTransportCodes.has(code)
      ? { transportCode: code as ManagedGoogleTransportCode }
      : {}),
    ...(typeof causeCode === "string" && allowedTransportCodes.has(causeCode)
      ? { causeTransportCode: causeCode as ManagedGoogleTransportCode }
      : {}),
  };
}
