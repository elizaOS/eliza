import { ElizaError } from "@elizaos/core";
import { expect, it } from "vitest";
import { buildLegacyShim } from "./dispatch-route";

const shimArgs = (body: unknown) => ({
  method: "POST",
  path: "/api/legacy-body",
  headers: {},
  query: {},
  params: {},
  body,
});

it("surfaces an unserializable request body instead of serving an empty one", () => {
  const body: Record<string, unknown> = { label: "cycle" };
  body.self = body;

  // A legacy handler that reads the request stream must not be told "the
  // client sent no body" when the dispatcher simply could not encode the body
  // it was given: that fabricates an empty request and hides the failure
  // behind the handler's own missing-field validation.
  let thrown: unknown;
  try {
    buildLegacyShim(shimArgs(body));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ElizaError);
  expect((thrown as ElizaError).code).toBe("ROUTE_REQUEST_BODY_UNSERIALIZABLE");
});

it("still streams a serializable body as JSON", async () => {
  const { req } = buildLegacyShim(shimArgs({ label: "ok" }));
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  expect(Buffer.concat(chunks).toString("utf8")).toBe('{"label":"ok"}');
});
