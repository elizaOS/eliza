import * as http from "node:http";
import { Socket } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyCors,
  CORS_ALLOWED_HEADERS,
} from "../../src/api/server-helpers-auth";

class HeaderCapture extends http.ServerResponse {
  readonly headers = new Map<string, string | number | readonly string[]>();

  constructor() {
    super(new http.IncomingMessage(new Socket()));
  }

  override setHeader(name: string, value: string | number | readonly string[]) {
    super.setHeader(name, value);
    this.headers.set(name, value);
    return this;
  }
}

class RequestWithOrigin extends http.IncomingMessage {
  constructor(origin: string) {
    super(new Socket());
    this.headers.host = "127.0.0.1:31337";
    this.headers.origin = origin;
  }
}

function requestWithOrigin(origin: string): http.IncomingMessage {
  return new RequestWithOrigin(origin);
}

describe("applyCors", () => {
  beforeEach(() => {
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_API_BIND;
    delete process.env.ELIZA_ALLOWED_ORIGINS;
  });

  it("allows app-core client headers used by Capacitor WebViews", () => {
    const res = new HeaderCapture();

    expect(applyCors(requestWithOrigin("https://localhost"), res, "/api/status")).toBe(
      true,
    );

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
