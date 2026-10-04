/** Narrow RFC9068 request binding for an explicitly configured Cloud owner gateway. */
export const CLOUD_RUNTIME_SCOPE = "cloud:runtime-request";
export const CLOUD_RUNTIME_CLIENT = "eliza-cloud-owner-gateway";
export const CLOUD_RUNTIME_HEADER = "x-eliza-cloud-owner-proof";
export const CLOUD_RUNTIME_MAX_BODY = 8 * 1024 * 1024;
export function cloudRuntimeTarget(target: string): string {
  if (
    !target.startsWith("/api/") ||
    target.includes("#") ||
    target.includes("\\") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject whitespace and control characters in the untrusted request target.
    /[\u0000-\u0020\u007f]/.test(target)
  )
    throw Error("Invalid runtime target");
  const path = target.split("?")[0];
  if (
    !/^\/api\/(?:client-devices|workflow|conversations)(?:\/|$)/.test(path) &&
    !/^\/api\/tts\/local-inference(?:\/status)?$/.test(path)
  )
    throw Error("Unsupported Cloud owner route");
  if (path.includes("//") || /%(?:2e|2f|5c)/i.test(path))
    throw Error("Ambiguous runtime target");
  const url = new URL(target, "https://runtime.invalid");
  if (
    url.origin !== "https://runtime.invalid" ||
    url.pathname + url.search !== target
  )
    throw Error("Noncanonical runtime target");
  return target;
}
export function cloudRuntimeMethod(method: string): string {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw Error("Unsupported runtime method");
  return method;
}
export async function cloudRuntimeDigest(bytes: Uint8Array): Promise<string> {
  if (bytes.length > CLOUD_RUNTIME_MAX_BODY)
    throw Error("Runtime body too large");
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

const VERIFIED_IDENTITY = Symbol.for(
  "eliza.cloud-runtime.verified-request-identity",
);
export function setCloudRuntimeRequestIdentity(
  request: object,
  identityId: string,
): void {
  Object.defineProperty(request, VERIFIED_IDENTITY, {
    value: identityId,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
export function getCloudRuntimeRequestIdentity(
  request: object,
): string | undefined {
  const value = (request as Record<symbol, unknown>)[VERIFIED_IDENTITY];
  return typeof value === "string" ? value : undefined;
}
