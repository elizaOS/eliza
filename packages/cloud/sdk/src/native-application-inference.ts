/** Applies explicit native product funding selection without falling back to personal prepaid inference. */
export class NativeApplicationInferenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeApplicationInferenceError";
  }
}

const supportedPaths = new Set([
  "/chat/completions",
  "/responses",
  "/embeddings",
]);

/** Applies only to model calls; configuration, billing and identity requests retain their normal transport. */
export function applyNativeApplicationInferenceHeaders(input: {
  slotKey: string | undefined;
  method: string;
  path: string;
  headers: Headers;
}): void {
  if (input.slotKey === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(input.slotKey))
    throw new NativeApplicationInferenceError(
      "NATIVE_APPLICATION_SLOT_INVALID",
      "Select a configured application product",
    );
  const pathname = new URL(
    input.path,
    "https://cloud-sdk.invalid",
  ).pathname.replace(/^\/api\/v1(?=\/)/, "");
  if (input.method !== "POST") return;
  if (!supportedPaths.has(pathname)) {
    if (
      /^\/(images|image|voice|audio|video|videos|music|speech|transcriptions|tts|stt|inference)(\/|$)/.test(
        pathname,
      )
    )
      throw new NativeApplicationInferenceError(
        "NATIVE_APPLICATION_SURFACE_UNSUPPORTED",
        "Selected application funding does not support this model operation",
      );
    return;
  }
  if (
    input.headers.has("X-App-Id") ||
    input.headers.has("X-Eliza-Developer-Authorization") ||
    input.headers.has("X-App-Delegation") ||
    input.headers.has("X-Affiliate-Code")
  )
    throw new NativeApplicationInferenceError(
      "NATIVE_APPLICATION_AUTHORITY_CONFLICT",
      "Native application funding cannot be combined with delegated or legacy app billing",
    );
  const operationId = input.headers.get("Idempotency-Key");
  if (!operationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationId))
    throw new NativeApplicationInferenceError(
      "NATIVE_APPLICATION_OPERATION_REQUIRED",
      "Persist an operation ID before dispatch and reuse it for retries",
    );
  const prior = input.headers.get("X-Eliza-Application-Slot");
  if (prior !== null && prior !== input.slotKey)
    throw new NativeApplicationInferenceError(
      "NATIVE_APPLICATION_AUTHORITY_CONFLICT",
      "The operation belongs to a different application product",
    );
  input.headers.set("X-Eliza-Application-Slot", input.slotKey);
}
