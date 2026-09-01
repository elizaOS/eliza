/**
 * Security tests exercise the authenticated calendar-card HTTP boundary over
 * real PGlite access rows and deterministic private bytes.
 */

import { createHash } from "node:crypto";
import type http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime, IFileStorageService } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { CalendarCardAccessStore } from "../lifeops/calendar-card.js";
import type { RawSqlQuery } from "../lifeops/sql.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

class PrivateFiles {
  readonly bytes = new Map<string, Buffer>();
  async storePrivate(value: Buffer | Uint8Array) {
    const bytes = Buffer.from(value);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const fileName = `${hash}.private-bin`;
    this.bytes.set(fileName, bytes);
    return { hash, fileName, mimeType: "text/html", size: bytes.length };
  }
  async readPrivate(fileName: string) {
    return this.bytes.get(fileName) ?? null;
  }
  async deletePrivate(fileName: string) {
    return this.bytes.delete(fileName);
  }
}

describe("calendar card authenticated route", () => {
  let runtime: AgentRuntime;
  let store: CalendarCardAccessStore;

  beforeEach(async () => {
    const db = await PGlite.create();
    const files = new PrivateFiles();
    runtime = {
      agentId: "agent-1",
      getService: () => files as unknown as IFileStorageService,
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
        },
      },
    } as unknown as AgentRuntime;
    store = new CalendarCardAccessStore(runtime);
  });

  async function request(url: string, principal = "owner-1") {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = Buffer.alloc(0);
    const req = { method: "GET", url } as http.IncomingMessage;
    const res = {
      writeHead(code: number, values: Record<string, string>) {
        status = code;
        Object.assign(headers, values);
      },
      end(value?: unknown) {
        body = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value === undefined ? "" : String(value));
      },
    } as unknown as http.ServerResponse;
    const parsed = new URL(url);
    const ctx: LifeOpsRouteContext = {
      req,
      res,
      method: "GET",
      pathname: parsed.pathname,
      url: parsed,
      state: {
        runtime,
        adminEntityId: principal as never,
        requestEntityId: principal,
      },
      json(response, data, code = 200) {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      },
      error(response, message, code = 400) {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      },
      async readJsonBody() {
        return null;
      },
      decodePathComponent(raw) {
        return decodeURIComponent(raw);
      },
    };
    await handleLifeOpsRoutes(ctx);
    return { status, headers, body };
  }

  it("serves once with privacy-safe headers and denies replay", async () => {
    const issued = await store.issue({
      recipientEntityId: "owner-1",
      html: "<!doctype html><html>private</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    const first = await request(issued.accessUrl);
    expect(first.status).toBe(200);
    expect(first.body.toString()).toContain("private");
    expect(first.headers).toMatchObject({
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    expect(first.headers["Content-Security-Policy"]).toContain(
      "default-src 'none'",
    );

    const replay = await request(issued.accessUrl);
    expect(replay.status).toBe(410);
    expect(JSON.parse(replay.body.toString())).toEqual({
      error: "CARD_ACCESS_REPLAY",
    });
  });

  it("denies a valid capability presented by the wrong authenticated identity", async () => {
    const issued = await store.issue({
      recipientEntityId: "owner-1",
      html: "<html>private</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    const denied = await request(issued.accessUrl, "guest-1");
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body.toString())).toEqual({
      error: "CARD_ACCESS_WRONG_IDENTITY",
    });
  });

  it("denies access immediately after owner revocation", async () => {
    const issued = await store.issue({
      recipientEntityId: "guest-1",
      html: "<html>private</html>",
      ttlMs: 60_000,
      baseUrl: "https://eliza.test",
    });
    await expect(store.revoke(issued.cardId)).resolves.toBe(true);
    const denied = await request(issued.accessUrl, "guest-1");
    expect(denied.status).toBe(410);
    expect(JSON.parse(denied.body.toString())).toEqual({
      error: "CARD_ACCESS_REVOKED",
    });
  });
});
