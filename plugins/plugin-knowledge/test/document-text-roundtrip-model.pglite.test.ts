import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { DocumentService } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { documentsRoutes } from "../src/plugin.ts";

interface ModelCase {
  sample: number;
  original: string;
  observed: string;
  saveRequested: boolean;
  saveRequests: number;
}

const texts = [
  "\n\n# Runbook\n\nRestart the worker.\n\n",
  "\t  Keep this spacing.\r\n\r\n",
  "\n  Café — 東京  \n",
];
const modelCases: ModelCase[] = process.env.ELIZA_DOCUMENT_TEXT_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_DOCUMENT_TEXT_MODEL_CASES, "utf8"),
    )
  : texts.flatMap((original, sample) =>
      [false, true].map((saveRequested) => ({
        sample,
        original,
        observed: original,
        saveRequested,
        saveRequests: Number(saveRequested),
      })),
    );

function routeFor(method: string, routePath: string) {
  const route = documentsRoutes.find(
    (candidate) => candidate.type === method && candidate.path === routePath,
  );
  if (!route?.routeHandler) throw new Error(`Missing ${method} ${routePath}`);
  return route.routeHandler;
}

function context(
  runtime: IAgentRuntime,
  method: string,
  routePath: string,
  body?: unknown,
): RouteHandlerContext {
  return {
    signal: new AbortController().signal,
    body,
    params: {},
    query: {},
    headers: { host: "localhost" },
    method,
    path: routePath,
    runtime,
    inProcess: false,
    isTrustedLocal: true,
  };
}

const owner = randomUUID() as UUID;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
beforeAll(async () => {
  fixture = await createTestRuntime({
    characterName: "DocumentTextModel",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  const { runtime } = fixture;
  await runtime.createEntity({
    id: owner,
    names: ["Owner"],
    agentId: runtime.agentId,
  });
  await runtime.registerService(DocumentService);
}, 120_000);
afterAll(async () => {
  await fixture?.cleanup();
}, 120_000);

it.each(modelCases)(
  "matches the document text model: sample $sample, save $saveRequested",
  async (model) => {
    const { runtime } = fixture;
    const uploaded = await routeFor(
      "POST",
      "/api/documents",
    )(
      context(runtime, "POST", "/api/documents", {
        filename: `model-${model.sample}-${model.saveRequested}.txt`,
        contentType: "text/plain",
        content: model.original,
        scope: "owner-private",
        metadata: { includeImageDescriptions: false },
      }),
    );
    expect(uploaded.status).toBe(200);
    const documentId = (uploaded.body as { documentId: string }).documentId;
    const routePath = `/api/documents/${documentId}`;
    const read = async () => {
      const result = await routeFor(
        "GET",
        "/api/documents/:id",
      )(context(runtime, "GET", routePath));
      expect(result.status).toBe(200);
      return (
        result.body as {
          document: { canEditText: boolean; content?: { text?: string } };
        }
      ).document;
    };
    const detail = await read();
    expect(detail.canEditText).toBe(true);
    expect(detail.content?.text).toBe(model.original);
    let saveRequests = 0;
    if (model.saveRequested) {
      const saved = await routeFor(
        "PATCH",
        "/api/documents/:id",
      )(
        context(runtime, "PATCH", routePath, {
          content: detail.content?.text,
        }),
      );
      expect(saved.status).toBe(200);
      saveRequests += 1;
    }
    const reread = await read();
    expect(reread.content?.text).toBe(model.observed);
    expect(Buffer.from(reread.content?.text ?? "")).toEqual(
      Buffer.from(model.original),
    );
    expect(saveRequests).toBe(model.saveRequests);
  },
  120_000,
);
