import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildLegacyShim } from "./dispatch-route";

const shimArgs = {
  method: "POST",
  path: "/api/legacy-upload",
  headers: { "content-type": "application/json" },
  query: {},
  params: {},
};

describe("buildLegacyShim request body serialization", () => {
  it("rejects a non-JSON-serializable body instead of streaming an empty body", () => {
    const circular: Record<string, unknown> = { uploadId: "abc" };
    circular.self = circular;

    expect(() => buildLegacyShim({ ...shimArgs, body: circular })).toThrow(
      /not JSON-serializable/,
    );
    expect(() => buildLegacyShim({ ...shimArgs, body: circular })).toThrow(
      expect.objectContaining({ code: "ROUTE_REQUEST_BODY_NOT_SERIALIZABLE" }),
    );
  });

  it("still streams a JSON body and treats an absent body as empty", async () => {
    const { req } = buildLegacyShim({
      ...shimArgs,
      body: { uploadId: "abc" },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"uploadId":"abc"}');

    const absent = buildLegacyShim({ ...shimArgs, body: null });
    const emptyChunks: Buffer[] = [];
    for await (const chunk of absent.req) emptyChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(emptyChunks).toString("utf8")).toBe("");
  });
});
