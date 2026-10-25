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

it("stores text files the browser labels with a binary MIME as their literal text", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "UploadTextEncoding",
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
    const files = [
      {
        filename: "export.csv",
        contentType: "application/vnd.ms-excel",
        content: "name,team\nAlice,Ops\nBob,Sales",
      },
      {
        filename: "notes.txt",
        contentType: "application/octet-stream",
        content: "Meet the vendor on Tuesday.",
      },
    ];

    const upload = await routeFor(
      "POST",
      "/api/documents/bulk",
    )(
      context(runtime, "POST", "/api/documents/bulk", {
        documents: files.map((file) => ({
          ...file,
          scope: "owner-private",
          metadata: { includeImageDescriptions: false },
        })),
      }),
    );
    expect(upload.status).toBe(200);
    const results = (
      upload.body as {
        results: Array<{ ok: boolean; documentId?: string; error?: string }>;
      }
    ).results;
    expect(results.map(({ ok, error }) => ({ ok, error }))).toEqual([
      { ok: true, error: undefined },
      { ok: true, error: undefined },
    ]);

    const storedTexts = [];
    for (const result of results) {
      const fragments = await routeFor(
        "GET",
        "/api/documents/:id/fragments",
      )(
        context(
          runtime,
          "GET",
          `/api/documents/${result.documentId}/fragments`,
        ),
      );
      expect(fragments.status).toBe(200);
      storedTexts.push(
        (fragments.body as { fragments: Array<{ text: string }> }).fragments
          .map((fragment) => fragment.text)
          .join("\n"),
      );
    }
    expect(storedTexts).toEqual([
      "name,team\nAlice,Ops\nBob,Sales",
      "Meet the vendor on Tuesday.",
    ]);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
