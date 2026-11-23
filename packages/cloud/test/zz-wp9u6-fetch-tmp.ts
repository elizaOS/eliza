/** @throws {never} */
export async function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return fetch(input, init); }
/** @throws {never} */
export function streamedAnswer(frames: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
/** @throws {never} */
export function seen(): { readonly urls: Array<string>; readonly headers: Array<Record<string, string>>; readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
  const urls: Array<string> = [];
  const headers: Array<Record<string, string>> = [];
  return { urls, headers, fetch: /** @throws {never} */ (input, init) => { urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); headers.push(Object.fromEntries(new Headers(init?.headers).entries())); return Promise.resolve(Response.json({ object: "list", data: [] })); } };
}
