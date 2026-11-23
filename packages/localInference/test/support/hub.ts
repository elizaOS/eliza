// spec/localInference/models.md, "A download is installed only when every file matches its published digest"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

/** A model hub at the network boundary: what it serves at each URL and the URLs it was asked for. */
export interface Hub {
  readonly client: HttpClient.HttpClient
  readonly requested: string[]
  /** @throws {never} */
  serve(url: string, body: string, status?: number): void
}

/** The SHA-256 a hub publishes for a body. @throws {never} */
export function digestOf(body: string): string {
  return createHash("sha256").update(body).digest("hex")
}

/** A hub that answers 404 for anything it does not serve. @throws {never} */
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
