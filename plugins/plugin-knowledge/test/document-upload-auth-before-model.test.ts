import { describe, expect, it } from "vitest";
import { handleDocumentsRoutes } from "../src/routes";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const GUEST_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";

type Captured = {
  json?: { status: number; data: unknown };
  error?: { message: string; status: number };
};

function makeHarness(options: {
  role: string;
  requesterId: string;
  body: Record<string, unknown>;
}) {
  const captured: Captured = {};
  let modelCalls = 0;
  let addDocumentCalls = 0;
  const fakeService = {
    addDocument: async () => {
      addDocumentCalls += 1;
      return { clientDocumentId: "doc-1", fragmentCount: 1 };
    },
  };
  const runtime = {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getService: (name: string) => (name === "documents" ? fakeService : null),
    useModel: async () => {
      modelCalls += 1;
      return "A photo of a cat.";
    },
    logger: { warn: () => {} },
    reportError: () => {},
  };
  const ctx = {
    req: {},
    res: {},
    method: "POST",
    pathname: "/api/documents",
    url: new URL("http://localhost/api/documents"),
    runtime,
    accessContext: {
      requesterEntityId: options.requesterId,
      role: options.role,
    },
    json: (_res: unknown, data: unknown, status = 200) => {
      captured.json = { status, data };
    },
    error: (_res: unknown, message: string, status = 400) => {
      captured.error = { message, status };
    },
    readJsonBody: async () => options.body,
  };
  return {
    ctx,
    captured,
    counts: () => ({ modelCalls, addDocumentCalls }),
  };
}

const IMAGE_BODY = {
  content: Buffer.from("fake-image-bytes").toString("base64"),
  filename: "photo.png",
  contentType: "image/png",
  metadata: { includeImageDescriptions: true },
};

describe("POST /api/documents image uploads", () => {
  it("does not call the image model for a user upload that global scope denies", async () => {
    const harness = makeHarness({
      role: "USER",
      requesterId: USER_ID,
      body: { ...IMAGE_BODY, scope: "global" },
    });
    const handled = await handleDocumentsRoutes(harness.ctx as never);
    expect(handled).toBe(true);
    expect(harness.counts().modelCalls).toBe(0);
    expect(harness.counts().addDocumentCalls).toBe(0);
    expect(harness.captured.error?.status).toBe(403);
  });

  it("does not call the image model for a guest upload and reports 403", async () => {
    const harness = makeHarness({
      role: "GUEST",
      requesterId: GUEST_ID,
      body: { ...IMAGE_BODY },
    });
    const handled = await handleDocumentsRoutes(harness.ctx as never);
    expect(handled).toBe(true);
    expect(harness.counts().modelCalls).toBe(0);
    expect(harness.counts().addDocumentCalls).toBe(0);
    expect(harness.captured.error?.status).toBe(403);
  });

  it("still describes and uploads an owner image upload", async () => {
    const harness = makeHarness({
      role: "OWNER",
      requesterId: OWNER_ID,
      body: { ...IMAGE_BODY, scope: "global" },
    });
    const handled = await handleDocumentsRoutes(harness.ctx as never);
    expect(handled).toBe(true);
    expect(harness.counts().modelCalls).toBe(1);
    expect(harness.counts().addDocumentCalls).toBe(1);
    expect(harness.captured.json?.status).toBe(200);
    expect(harness.captured.error).toBeUndefined();
  });
});
