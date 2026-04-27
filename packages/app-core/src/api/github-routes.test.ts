/**
 * Unit tests for github-routes.ts — the HTTP surface that powers
 * Settings → Coding Agents → GitHub.
 *
 * Covers:
 * - GET /api/github/token returns connected=false when no record
 * - GET /api/github/token returns metadata + connected=true when a record exists
 * - GET never returns the token itself
 * - POST validates the token via api.github.com/user (success path)
 * - POST surfaces a 400 with a useful message on a 401 from GitHub
 * - POST surfaces a 400 with a useful message on a 403 from GitHub
 * - POST 400s on an empty body
 * - POST persists scopes parsed from the X-OAuth-Scopes header
 * - DELETE clears the saved record (and is idempotent)
 * - non-GET/POST/DELETE methods get a 405
 *
 * Each test uses a fresh tmp state-dir + an injected `fetch` so no
 * network calls escape and no on-disk state leaks between cases.
 */

import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGitHubRoutes } from "./github-routes";
import {
  buildCredentialsFromUserResponse,
  clearCredentials,
  saveCredentials,
} from "../services/github-credentials";

interface FakeResponseRecord {
  status: number;
  body: unknown;
}

function makeFakeReq(payload?: unknown): http.IncomingMessage {
  const source =
    payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
  return Readable.from(source) as unknown as http.IncomingMessage;
}

function makeFakeRes(): {
  res: http.ServerResponse;
  captured: FakeResponseRecord;
} {
  const captured: FakeResponseRecord = { status: 0, body: null };
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end(chunk?: string) {
      captured.status = (this as { statusCode: number }).statusCode;
      captured.body = chunk ? JSON.parse(chunk) : null;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function makeUserResponse(
  body: unknown,
  init: { status?: number; scopes?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      "x-oauth-scopes": init.scopes ?? "",
    },
  });
}

let tempDir: string;
let originalStateDir: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "milady-github-routes-"));
  originalStateDir = process.env.MILADY_STATE_DIR;
  process.env.MILADY_STATE_DIR = tempDir;
});

afterEach(async () => {
  if (originalStateDir === undefined) {
    delete process.env.MILADY_STATE_DIR;
  } else {
    process.env.MILADY_STATE_DIR = originalStateDir;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("GET /api/github/token", () => {
  it("returns connected=false when no record is saved", async () => {
    const { res, captured } = makeFakeRes();
    const handled = await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "GET",
      pathname: "/api/github/token",
    });
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ connected: false });
  });

  it("returns metadata when a record exists", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse(
        "ghp_secret_should_not_leak",
        { login: "octocat" },
        ["repo", "read:user"],
        1_700_000_000_000,
      ),
    );
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "GET",
      pathname: "/api/github/token",
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      connected: true,
      username: "octocat",
      scopes: ["repo", "read:user"],
      savedAt: 1_700_000_000_000,
    });
  });

  it("never includes the token in the response body", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse(
        "ghp_secret_should_not_leak",
        { login: "octocat" },
        ["repo"],
        1,
      ),
    );
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "GET",
      pathname: "/api/github/token",
    });
    expect(JSON.stringify(captured.body)).not.toContain(
      "ghp_secret_should_not_leak",
    );
  });
});

describe("POST /api/github/token", () => {
  it("validates the token, persists it, and returns metadata", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        makeUserResponse(
          { login: "octocat" },
          { scopes: "repo, read:user" },
        ),
      );

    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq({ token: "ghp_supplied" }),
      res,
      method: "POST",
      pathname: "/api/github/token",
      fetch: fetchSpy as unknown as typeof fetch,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({
      Authorization: "Bearer ghp_supplied",
    });

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      connected: true,
      username: "octocat",
      scopes: ["repo", "read:user"],
    });

    // The token must be persisted.
    const filePath = path.join(tempDir, "credentials", "github.json");
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8")) as {
      token: string;
      username: string;
    };
    expect(onDisk.token).toBe("ghp_supplied");
    expect(onDisk.username).toBe("octocat");
  });

  it("returns 400 when GitHub answers 401", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq({ token: "ghp_bad" }),
      res,
      method: "POST",
      pathname: "/api/github/token",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toMatch(/bad credentials/i);
  });

  it("returns 400 when GitHub answers 403", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 403 }));
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq({ token: "ghp_low_scope" }),
      res,
      method: "POST",
      pathname: "/api/github/token",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toMatch(/forbidden/i);
  });

  it("returns 400 when the body has no token", async () => {
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq({}),
      res,
      method: "POST",
      pathname: "/api/github/token",
    });
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toMatch(/missing/i);
  });
});

describe("DELETE /api/github/token", () => {
  it("clears the saved credential and returns 204", async () => {
    await saveCredentials(
      buildCredentialsFromUserResponse("t", { login: "u" }, [], 1),
    );
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "DELETE",
      pathname: "/api/github/token",
    });
    expect(captured.status).toBe(204);
    await expect(
      fs.stat(path.join(tempDir, "credentials", "github.json")),
    ).rejects.toThrow();
  });

  it("is idempotent when nothing is saved", async () => {
    await clearCredentials();
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "DELETE",
      pathname: "/api/github/token",
    });
    expect(captured.status).toBe(204);
  });
});

describe("non-matching paths and methods", () => {
  it("returns false for unrelated paths", async () => {
    const { res } = makeFakeRes();
    const handled = await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "GET",
      pathname: "/api/something-else",
    });
    expect(handled).toBe(false);
  });

  it("returns 405 for unsupported methods on the canonical path", async () => {
    const { res, captured } = makeFakeRes();
    await handleGitHubRoutes({
      req: makeFakeReq(),
      res,
      method: "PATCH",
      pathname: "/api/github/token",
    });
    expect(captured.status).toBe(405);
  });
});
