import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { tryHandleLifeOpsInboxFallback } from "./lifeops-inbox-fallback-routes.ts";

function makeRes() {
  const headers = new Map<string, string>();
  let body = "";
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(value?: string) {
      body = value ?? "";
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return (res as { statusCode: number }).statusCode;
    },
    get body() {
      return JSON.parse(body) as Record<string, unknown>;
    },
    header(name: string) {
      return headers.get(name.toLowerCase());
    },
  };
}

describe("tryHandleLifeOpsInboxFallback", () => {
  it("does not handle unrelated routes", () => {
    const captured = makeRes();
    expect(
      tryHandleLifeOpsInboxFallback({
        pathname: "/api/lifeops/goals",
        method: "GET",
        url: new URL("http://localhost/api/lifeops/goals"),
        res: captured.res,
      }),
    ).toBe(false);
  });

  it("returns an empty inbox wire payload when no plugin handled the route", () => {
    const captured = makeRes();
    const handled = tryHandleLifeOpsInboxFallback({
      pathname: "/api/lifeops/inbox",
      method: "GET",
      url: new URL("http://localhost/api/lifeops/inbox"),
      res: captured.res,
    });
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.header("content-type")).toContain("application/json");
    expect(captured.body.messages).toEqual([]);
    expect(captured.body.sources).toEqual([]);
    expect(captured.body.available).toBe(false);
    expect(captured.body.channelCounts).toMatchObject({
      gmail: { total: 0, unread: 0 },
      discord: { total: 0, unread: 0 },
      sms: { total: 0, unread: 0 },
    });
    expect(typeof captured.body.fetchedAt).toBe("string");
  });

  it("validates channel filters with the same contract as the PA route", () => {
    const captured = makeRes();
    const handled = tryHandleLifeOpsInboxFallback({
      pathname: "/api/lifeops/inbox",
      method: "GET",
      url: new URL("http://localhost/api/lifeops/inbox?channels=gmail,nope"),
      res: captured.res,
    });
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect(String(captured.body.error)).toContain(
      "channels must be a comma-separated subset",
    );
  });
});
