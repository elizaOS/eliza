// spec/localInference/models.md, "A download is installed only when every file matches its published digest"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export interface Hub {
  readonly client: HttpClient.HttpClient
  readonly requested: string[]
  /** @throws {never} */
  serve(url: string, body: string, status?: number): void
}

/** @throws {never} */
export function digestOf(body: string): string {
  return createHash("sha256").update(body).digest("hex")
}

/** @throws {never} */
export function hub(): Hub {
  const served = new Map<string, { readonly body: string; readonly status: number }>()
  const requested: string[] = []
  return {
    requested,
    serve: (url, body, status = 200) => { served.set(url, { body, status }) },
    client: HttpClient.make((request, url) => {
      requested.push(url.href)
      const found = served.get(url.href)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(found?.body ?? "missing", { status: found?.status ?? 404 })))
    }),
  }
}
