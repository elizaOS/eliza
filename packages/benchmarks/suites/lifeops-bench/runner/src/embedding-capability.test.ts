import { createServer } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { probeBenchmarkEmbedding } from "./embedding-capability.js";

let endpoint: string;
const bodies: unknown[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  bodies.push(JSON.parse(body));
  if (req.url === "/unavailable") {
    res.writeHead(503);
    res.end("Embedding provider unavailable");
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/zero" ? [0, 0] : [0.25, -0.5]));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP address");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const generate = (path: string) => async () => {
  const response = await fetch(endpoint + path, {
    method: "POST",
    body: JSON.stringify({ input: "Real embedding probe text" }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
test("records successful text vector generation across HTTP", async () => {
  expect(
    await probeBenchmarkEmbedding({
      disabled: false,
      standIn: false,
      generate: generate("/valid"),
    }),
  ).toEqual({ status: "available", dimension: 2 });
  expect(bodies.at(-1)).toEqual({ input: "Real embedding probe text" });
});
test("preserves endpoint failure instead of claiming semantic memory", async () => {
  expect(
    await probeBenchmarkEmbedding({
      disabled: false,
      standIn: false,
      generate: generate("/unavailable"),
    }),
  ).toEqual({ status: "unavailable", error: "Embedding provider unavailable" });
});
test("rejects zero-vector stand-ins", async () => {
  expect(
    await probeBenchmarkEmbedding({
      disabled: false,
      standIn: false,
      generate: generate("/zero"),
    }),
  ).toMatchObject({ status: "unavailable" });
});
test.each(["disabled", "stand-in"] as const)(
  "does not invoke embeddings in %s mode",
  async (status) => {
    const previous = bodies.length;
    expect(
      await probeBenchmarkEmbedding({
        disabled: status === "disabled",
        standIn: status === "stand-in",
        generate: generate("/valid"),
      }),
    ).toEqual({ status });
    expect(bodies).toHaveLength(previous);
  },
);
