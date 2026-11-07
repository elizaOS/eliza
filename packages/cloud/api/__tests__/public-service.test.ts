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

test("split public service bindings preserve full legal text and reject partial or oversized configuration", async () => {
  const document = {
    title: "Terms",
    revision: "published-revision",
    sections: [
      {
        title: "Scope",
        paragraphs: [
          "  " + "é".repeat(1500) + "\nUnmodified final paragraph.  ",
        ],
      },
    ],
  };
  const service = {
    name: "Eliza",
    terms: document,
    privacy: { ...document, title: "Privacy" },
  };
  expect(Buffer.byteLength(JSON.stringify(service))).toBeGreaterThan(5120);
  const complete = {
    CLOUD_PUBLIC_SERVICE_NAME: service.name,
    CLOUD_PUBLIC_SERVICE_TERMS_JSON: JSON.stringify(service.terms),
    CLOUD_PUBLIC_SERVICE_PRIVACY_JSON: JSON.stringify(service.privacy),
  };
  let configured: Record<string, string> = complete;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => app.fetch(request, configured),
  });
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect<unknown>(await response.json()).toEqual({
      success: true,
      version: 1,
      service,
    });
    for (const invalid of [
      { CLOUD_PUBLIC_SERVICE_NAME: "Eliza" },
      { ...complete, CLOUD_PUBLIC_SERVICE_TERMS_JSON: "" },
      { ...complete, CLOUD_PUBLIC_SERVICE_TERMS_JSON: "not json" },
      { ...complete, CLOUD_PUBLIC_SERVICE_TERMS_JSON: "{}" },
      { ...complete, CLOUD_PUBLIC_SERVICE_NAME: "é".repeat(2561) },
    ]) {
      // A valid legacy object must never hide a partial or invalid new tuple.
      configured = {
        CLOUD_PUBLIC_SERVICE_JSON: JSON.stringify(service),
        ...invalid,
      };
      const rejected = await fetch(server.url);
      expect(rejected.status).toBe(503);
      expect<unknown>(await rejected.json()).toEqual({
        success: false,
        error: "service_metadata_unavailable",
      });
    }
  } finally {
    server.stop(true);
  }
});
