import { randomUUID } from "node:crypto";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { DocumentService } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { documentsRoutes } from "../src/plugin.ts";

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

it("stores an .html file the browser labels with a binary MIME as its literal text", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "UploadHtmlEncoding",
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
    // Same contract as the .csv/.txt cases in
    // document-upload-text-encoding.pglite.test.ts: literal text arrives with
    // a binary MIME, and the filename is what proves it is text.
    const html =
      "<html><body><h1>Hello knowledge</h1><p>Unique phrase zanzibar</p></body></html>";

    const upload = await routeFor(
      "POST",
      "/api/documents",
    )(
      context(runtime, "POST", "/api/documents", {
        filename: "page.html",
        contentType: "application/octet-stream",
        content: html,
        scope: "owner-private",
        metadata: { includeImageDescriptions: false },
      }),
    );
    expect(upload.status).toBe(200);
    const documentId = (upload.body as { documentId: string }).documentId;

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
    expect(storedText).toContain("Hello knowledge");
    expect(storedText).toContain("Unique phrase zanzibar");
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
