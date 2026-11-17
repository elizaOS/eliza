// spec/cloud/index.md, "Story: Use inference on my subscription or funded pilot account"
export const WorkerResponse = globalThis.Response
export const WorkerStream = globalThis.ReadableStream
export const WorkerHeaders = globalThis.Headers
export const workerFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)
export const newRequestId = () => globalThis.crypto.randomUUID()

export function withRequestBody(request: Request, bytes: Uint8Array) {
  return new Request(request, { body: Uint8Array.from(bytes) })
}
