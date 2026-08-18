/** Account-pool usage windows require canonical non-negative timestamps. */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetAccountPoolBrokerRoutesForTests,
  handleAccountPoolBrokerRoute,
} from "./account-pool-broker-routes.js";

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

const SECRET = "test-broker-fixture-test-broker-fixture-test";

let home: string;
let prevHome: string | undefined;
let prevStateDir: string | undefined;
let prevEnabled: string | undefined;
let prevSecret: string | undefined;

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = pathname;
  req.headers = {
    host: "127.0.0.1:18792",
    authorization: `Bearer ${SECRET}`,
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

async function getUsage(query: string): Promise<FakeRes> {
  const res = fakeRes();
  await handleAccountPoolBrokerRoute(
    fakeReq(`/api/internal/account-pool/v1/usage${query}`),
    res.res,
  );
  return res;
}

beforeEach(() => {
  prevHome = process.env.ELIZA_HOME;
  prevStateDir = process.env.ELIZA_STATE_DIR;
  prevEnabled = process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
  prevSecret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  home = mkdtempSync(path.join(tmpdir(), "account-pool-broker-limit-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = "1";
  process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = SECRET;
  __resetAccountPoolBrokerRoutesForTests();
});

afterEach(() => {
  __resetAccountPoolBrokerRoutesForTests();
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.ELIZA_HOME;
  else process.env.ELIZA_HOME = prevHome;
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevEnabled === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED = prevEnabled;
  if (prevSecret === undefined)
    delete process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET;
  else process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET = prevSecret;
});

describe("account-pool broker usage query integers", () => {
  it("startMs=1e2 is 400 before a usage window is applied", async () => {
    const res = await getUsage("?startMs=1e2");
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({ ok: false, error: "invalid_usage_query" });
  });

  it("endMs=007 is 400 before a usage window is applied", async () => {
    const res = await getUsage("?endMs=007");
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({ ok: false, error: "invalid_usage_query" });
  });

  it("startMs=0x10 is 400 before a usage window is applied", async () => {
    const res = await getUsage("?startMs=0x10");
    expect(res.status()).toBe(400);
    expect(res.body()).toEqual({ ok: false, error: "invalid_usage_query" });
  });

  it("canonical startMs=0 still reaches the usage query", async () => {
    const res = await getUsage("?startMs=0");
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ ok: true });
  });
});
