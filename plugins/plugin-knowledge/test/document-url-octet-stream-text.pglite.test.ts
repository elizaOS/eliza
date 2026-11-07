import { randomUUID } from "node:crypto";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { DocumentService } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import { documentsRoutes } from "../src/plugin.ts";
import { __setDocumentFetchImplForTests } from "../src/routes.ts";

function routeFor(type: string, path: string) {
  const route = documentsRoutes.find(
    (candidate) => candidate.type === type && candidate.path === path,
  );
  if (!route?.routeHandler) throw new Error(`missing route ${type} ${path}`);
  return route.routeHandler;
}

function context(
  runtime: IAgentRuntime,
  method: string,
  path: string,
  body?: unknown,
): RouteHandlerContext {
  return {
    signal: new AbortController().signal,
    body,
    params: {},
    query: {},
    headers: { host: "localhost" },
    method,
    path,
    runtime,
    inProcess: false,
    isTrustedLocal: true,
  };
}

afterEach(() => {
  __setDocumentFetchImplForTests(null);
});

it("stores a .txt file served as application/octet-stream as readable text", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "UploadUrlOctetStreamText",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.createEntity({
      id: owner,
      names: ["Owner"],
      agentId: runtime.agentId,
    });
    await runtime.registerService(DocumentService);
    // The host serves a plain .txt file without a text MIME type (S3 objects
    // and generic file hosts default to application/octet-stream). The URL
    // path is the only signal that the bytes are text.
    // IP-literal host: resolveSafeUrlTarget accepts a public IP without a
    // DNS lookup, so the stubbed fetch below is the only network stand-in.
    const text = "Meet the vendor on Tuesday. Unique phrase zanzibar";
    __setDocumentFetchImplForTests(
      async () =>
        new Response(text, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const upload = await routeFor(
      "POST",
      "/api/documents/url",
    )(
      context(runtime, "POST", "/api/documents/url", {
        url: "https://93.184.216.34/notes.txt",
        scope: "owner-private",
      }),
    );
    expect(upload.status).toBe(200);
    const documentId = (upload.body as { documentId: string }).documentId;

    const detail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${documentId}`));
    expect(detail.status).toBe(200);
    const document = (
      detail.body as {
        document: { canEditText: boolean; content?: { text?: string } };
      }
    ).document;
    expect(document.canEditText).toBe(true);
    expect(document.content).toEqual({ text });

    const fragments = await routeFor(
      "GET",
      "/api/documents/:id/fragments",
    )(context(runtime, "GET", `/api/documents/${documentId}/fragments`));
    expect(fragments.status).toBe(200);
    const storedText = (
      fragments.body as { fragments: Array<{ text: string }> }
    ).fragments
      .map((fragment) => fragment.text)
      .join("\n");
    expect(storedText).toContain("Unique phrase zanzibar");
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
