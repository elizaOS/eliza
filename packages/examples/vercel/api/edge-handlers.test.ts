import { describe, expect, test } from "bun:test";
import chatHandler from "./chat";
import healthHandler from "./health";

// Real in-process coverage of the Vercel Edge handlers (#10718). Previously the
// package `test` script was `bun run test-client.ts || echo 'skipping'`, which
// (a) required a running API endpoint the CI has no way to provide and (b) the
// `|| echo` swallowed ANY failure so the lane was permanently green even on a
// genuine crash. These tests boot the Web-standard `(Request) => Response`
// handlers directly — no network, no LLM — and assert the real
// method/validation/CORS contract, so a regression in the edge functions fails.
describe("vercel edge handlers (in-process, no network)", () => {
  test("health returns 200 healthy JSON with permissive CORS", async () => {
    const res = healthHandler(new Request("http://x/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { status: string; runtime: string };
    expect(body.status).toBe("healthy");
    expect(body.runtime).toBe("elizaos-typescript");
  });

  test("chat OPTIONS preflight returns 200", async () => {
    const res = await chatHandler(
      new Request("http://x/api/chat", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(200);
  });

  test("chat rejects a non-POST method with 405", async () => {
    const res = await chatHandler(
      new Request("http://x/api/chat", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });

  test("chat rejects a POST with a missing/empty/non-string message with 400", async () => {
    const badBodies = [{}, { message: "" }, { message: "   " }, { message: 42 }];
    for (const body of badBodies) {
      const res = await chatHandler(
        new Request("http://x/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  test("chat rejects an invalid JSON body with 400 BAD_REQUEST", async () => {
    const res = await chatHandler(
      new Request("http://x/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not valid json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("BAD_REQUEST");
  });
});
