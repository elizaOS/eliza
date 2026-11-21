export const hostFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init);
export function streamedAnswer(frames: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}
export function seen(): { readonly urls: Array<string>; readonly headers: Array<Record<string, string>>; readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
  const urls: Array<string> = [];
  const headers: Array<Record<string, string>> = [];
  return { urls, headers, fetch: async (input, init) => { urls.push(String(input)); headers.push(Object.fromEntries(new Headers(init?.headers).entries())); return Response.json({ object: "list", data: [] }); } };
}
