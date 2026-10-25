/** Rejects unsupported native product selections before any provider or prepaid route can dispatch. */
const supportedPaths = new Set([
  "/api/v1/chat/completions",
  "/api/v1/responses",
  "/api/v1/embeddings",
]);
/** Call before routing any selected request: an unsupported surface must never enter prepaid admission. */
export function nativeApplicationSelectionSurfaceError(request: Request): Response | null {
  if (!request.headers.has("X-Eliza-Application-Slot")) return null;
  if (request.method === "POST" && supportedPaths.has(new URL(request.url).pathname)) return null;
  return Response.json(
    {
      error: {
        code: "APP_INFERENCE_SURFACE_UNSUPPORTED",
        message: "The selected application product does not support this inference surface",
      },
    },
    { status: 400 },
  );
}
