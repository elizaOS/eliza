// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import { types } from "pg"

export const WorkerResponse = globalThis.Response
export const WorkerRequest = globalThis.Request
export const WorkerHeaders = globalThis.Headers
export const workerFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

export async function limitedBody(request: Pick<Request, "body">, limit: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(part.value)
    }
    const body = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  } finally {
    reader.releaseLock()
  }
}

export interface WorkerLifetime {
  waitUntil(work: Promise<unknown>): void
}

export function withRequestBody(request: Request, bytes: Uint8Array) {
  return new Request(request, { body: Uint8Array.from(bytes) })
}

/** @throws {RangeError} */
function safeInteger(text: string): number {
  const value = BigInt(text)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`int8 ${text} is outside the safe range`)
  return Number(value)
}

export const safeIntegerTypes = {
  getTypeParser: (oid: number, format?: Parameters<typeof types.getTypeParser>[1]): unknown => oid === 20 ? safeInteger : types.getTypeParser(oid, format)
}
