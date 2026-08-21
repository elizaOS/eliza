/** Test-only CSRF transport seam; component tests inject a Maps transport. */

export async function fetchWithCsrf(
  _input: RequestInfo | URL,
  _init?: RequestInit,
): Promise<Response> {
  throw new Error("Maps component tests must inject their transport.");
}
