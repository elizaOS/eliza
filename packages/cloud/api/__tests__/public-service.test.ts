import { expect, test } from "bun:test";
import app from "../public/service/route";

test("public service HTTP returns exact deployment text without a session and refuses invalid configuration", async () => {
  const document = {
    title: "Terms",
    revision: "test-revision",
    sections: [
      { title: "Scope", paragraphs: ["  Provider text.\nSecond line.  "] },
    ],
  };
  let configured: string | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) =>
      app.fetch(request, { CLOUD_PUBLIC_SERVICE_JSON: configured }),
  });
  try {
    for (const name of ["First service", "Independent service"]) {
      const service = { name, terms: document, privacy: document };
      configured = JSON.stringify(service);
      const response = await fetch(server.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect<unknown>(await response.json()).toEqual({
        success: true,
        version: 1,
        service,
      });
    }
    for (const invalid of [
      undefined,
      "{}",
      "not json",
      "x".repeat(262145),
      JSON.stringify({ name: "Wrong shape", terms: document }),
    ]) {
      configured = invalid;
      const response = await fetch(server.url);
      expect(response.status).toBe(503);
      expect<unknown>(await response.json()).toEqual({
        success: false,
        error: "service_metadata_unavailable",
      });
    }
  } finally {
    server.stop(true);
  }
});
