import type http from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCors,
  CORS_ALLOWED_HEADERS,
} from "../../src/api/server-helpers-auth";

class HeaderCapture {
  readonly headers = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name, value);
    return this;
  }
}

function requestWithOrigin(origin: string): http.IncomingMessage {
  return {
    headers: {
      host: "127.0.0.1:31337",
      origin,
    },
  } as http.IncomingMessage;
}

describe("applyCors", () => {
  beforeEach(() => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_API_BIND;
    delete process.env.ELIZA_ALLOWED_ORIGINS;
  });

  it("allows app-core client headers used by Capacitor WebViews", () => {
    const res = new HeaderCapture();

    expect(
      applyCors(
        requestWithOrigin("https://localhost"),
        res as unknown as http.ServerResponse,
        "/api/status",
      ),
    ).toBe(true);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      CORS_ALLOWED_HEADERS,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");

    const allowedHeaders = String(
      res.headers.get("Access-Control-Allow-Headers"),
    );
    expect(allowedHeaders).toContain("X-ElizaOS-Client-Id");
    expect(allowedHeaders).toContain("X-ElizaOS-UI-Language");
    expect(allowedHeaders).toContain("X-ElizaOS-Token");
  });
});
