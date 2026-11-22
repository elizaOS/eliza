/// <reference types="vite/client" />
// spec/cloud/client.md, "Story: Use the cloud from the device as configured"
import { assert, describe, expect, it } from "vitest"
import { createCloudClient } from "../src/client/index.vibe"

const sources: Readonly<Record<string, string>> = import.meta.glob(["../src/**/*.{vibe,ts}", "../gen/*.{vibe,ts}"], { query: "?raw", import: "default", eager: true })

const importPattern = /(?:^|[\s;}])(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*(?:\(\s*)?["']([^"']+)["']/gm

function resolved(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1)
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== ".") parts.push(part)
  }
  return parts.join("/")
}

function reachable(entry: string): { readonly files: ReadonlyArray<string>; readonly packages: ReadonlyArray<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop() as string
    if (files.has(file)) continue
    files.add(file)
    for (const found of (sources[file] ?? "").matchAll(importPattern)) {
      const specifier = found[1] ?? found[2] ?? ""
      if (specifier.startsWith(".")) pending.push(resolved(file, specifier))
      else packages.add(specifier)
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() }
}

describe("Cloud client in Chromium", () => {
  it("Reads the held credential for each request (spec/cloud/client.md, \"Every call reads the credential when it is sent\")", async () => {
    const graph = reachable("../src/client/index.vibe")
    const missing = graph.files.filter((file) => sources[file] === undefined)
    const serverFiles = graph.files.filter((file) => /^\.\.\/src\/(http|store)\//.test(file))
    const forbidden = graph.packages.filter((name) => name.startsWith("node:") || name.startsWith("@elizaos/") || !/^(effect|vibelang-runtime)(\/|$)/.test(name))

    const sent: Array<{ readonly path: string; readonly authorization: string | null; readonly redirect: RequestRedirect; readonly credentials: RequestCredentials }> = []
    let held = "eliza_mobile_first"
    let credentialReads = 0
    const credential = () => {
      credentialReads += 1
      return held
    }
    const client = createCloudClient({
      baseUrl: "https://api.example.com",
      credential,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new globalThis.Request(input, init)
        sent.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), redirect: request.redirect, credentials: request.credentials })
        return globalThis.Response.json({ object: "list", data: [{ id: "test-chat", object: "model", owned_by: "llm" }] })
      }
    })
    await client.models()
    held = "eliza_mobile_second"
    await client.models()
    const invalid = { failure: { tag: "CloudRefused", code: "InvalidRequest", reason: "NoReason" } }
    expect(() => createCloudClient({ baseUrl: "https://api.example.com/api/../", credential })).toThrowError(expect.objectContaining(invalid))
    await expect(client.calendarEvent({ eventId: ".." })).rejects.toMatchObject(invalid)

    assert.deepStrictEqual(
      { missing, serverFiles, forbidden, sent, credentialReads, inBrowser: typeof window === "object" && typeof document === "object" },
      { missing: [], serverFiles: [], forbidden: [], sent: [
        { path: "/api/v1/models", authorization: "Bearer eliza_mobile_first", redirect: "error", credentials: "omit" },
        { path: "/api/v1/models", authorization: "Bearer eliza_mobile_second", redirect: "error", credentials: "omit" }
      ], credentialReads: 2, inBrowser: true }
    )
  })
})
