import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyTokenIdentity } from "./cloudflare-token-identity-preflight.ts";

const ID = "a".repeat(32);
const ACCOUNT = "b".repeat(32);
const identity = { success: true, result: { id: ID, status: "active" } };
const policies = {
  success: true,
  result: {
    id: ID,
    name: "private token name",
    policies: [
      {
        id: "c".repeat(32),
        effect: "allow",
        permission_groups: [
          { id: "e".repeat(32), name: "Workers Observability Write" },
        ],
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
      },
      {
        id: "d".repeat(32),
        effect: "deny",
        permission_groups: [
          { id: "e".repeat(32), name: "Workers Observability Write" },
        ],
        resources: { "private resource selector": "*" },
      },
    ],
  },
};

async function withHttp(
  handler: RequestListener,
  run: (fetchImpl: typeof fetch, origin: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const mappedFetch: typeof fetch = (url, options) => {
    assert(options);
    const target = new URL(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    );
    assert.equal(target.origin, "https://api.cloudflare.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return fetch(new URL(target.pathname, origin), options);
  };
  try {
    await run(mappedFetch, origin);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("real HTTP inventory uses verified fixed selectors and emits only closed policy counts", async () => {
  const paths: string[] = [];
  await withHttp(
    (request, response) => {
      assert.equal(request.headers.authorization, "Bearer fixture");
      assert(request.url);
      paths.push(request.url);
      json(response, request.url?.endsWith("/verify") ? identity : policies);
    },
    async (fetchImpl) => {
      const result = await verifyTokenIdentity({
        endpoint: "account",
        token: "fixture",
        accountId: ACCOUNT,
        fetchImpl,
        includePermissions: true,
      });
      assert.equal(result.status, "active");
      assert.deepEqual(result.permissionReport, {
        httpStatus: 200,
        failure: null,
        policyCount: 2,
        observabilityWriteAllowPolicyCount: 1,
        observabilityWriteDenyPolicyCount: 1,
        scope: "token_policy_metadata_only",
      });
      const output = JSON.stringify(result);
      for (const privateValue of [
        ID,
        ACCOUNT,
        "private token name",
        "private resource selector",
        "Bearer fixture",
        "permission_groups",
      ])
        assert(!output.includes(privateValue));
    },
  );
  assert.deepEqual(paths, [
    `/client/v4/accounts/${ACCOUNT}/tokens/verify`,
    `/client/v4/accounts/${ACCOUNT}/tokens/${ID}`,
  ]);
});

test("default identity check never reads policy metadata", async () => {
  let calls = 0;
  await withHttp(
    (_request, response) => {
      calls++;
      json(response, identity);
    },
    async (fetchImpl) => {
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token: "fixture",
        fetchImpl,
      });
      assert.equal(result.status, "active");
      assert(!Object.hasOwn(result, "permissionReport"));
    },
  );
  assert.equal(calls, 1);
});

test("actual denied policy read retains verified identity and unknown permission counts", async () => {
  await withHttp(
    (request, response) =>
      json(
        response,
        request.url?.endsWith("/verify")
          ? identity
          : { errors: [{ message: "private provider denial" }] },
        request.url?.endsWith("/verify") ? 200 : 403,
      ),
    async (fetchImpl) => {
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token: "fixture",
        fetchImpl,
        includePermissions: true,
      });
      assert.equal(result.status, "active");
      assert.equal(result.failure, null);
      assert.deepEqual(result.permissionReport, {
        httpStatus: 403,
        failure: "http_error",
        policyCount: null,
        observabilityWriteAllowPolicyCount: null,
        observabilityWriteDenyPolicyCount: null,
        scope: "token_policy_metadata_only",
      });
      assert(!JSON.stringify(result).includes("private provider denial"));
    },
  );
});

test("foreign token and malformed or incomplete policy authority cannot produce counts", async () => {
  for (const invalid of [
    { ...policies, result: { ...policies.result, id: "c".repeat(32) } },
    { success: true, result: { id: ID } },
    {
      success: true,
      result: {
        id: ID,
        policies: [{ effect: "allow", permission_groups: [], resources: null }],
      },
    },
  ]) {
    await withHttp(
      (request, response) =>
        json(response, request.url?.endsWith("/verify") ? identity : invalid),
      async (fetchImpl) => {
        const result = await verifyTokenIdentity({
          endpoint: "user",
          token: "fixture",
          fetchImpl,
          includePermissions: true,
        });
        assert.equal(result.permissionReport?.failure, "invalid_response");
        assert.equal(result.permissionReport?.policyCount, null);
      },
    );
  }
});

test("the existing shared deadline cancels a live policy request without erasing identity", async () => {
  await withHttp(
    (request, response) => {
      if (request.url?.endsWith("/verify")) json(response, identity);
    },
    async (fetchImpl) => {
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token: "fixture",
        fetchImpl,
        includePermissions: true,
        deadlineMs: 100,
      });
      assert.equal(result.status, "active");
      assert.equal(result.permissionReport?.failure, "timeout");
      assert.equal(result.permissionReport?.policyCount, null);
    },
  );
});

test("real CLI process fails unknown permissions with closed receipts, without model or write calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "token-capability-process-"));
  try {
    await withHttp(
      (request, response) => {
        assert.equal(request.method, "GET");
        json(
          response,
          request.url?.endsWith("/verify")
            ? identity
            : { errors: [{ message: "private denial" }] },
          request.url?.endsWith("/verify") ? 200 : 403,
        );
      },
      async (_fetchImpl, origin) => {
        const preload = join(directory, "preload.mjs");
        await writeFile(
          preload,
          `const original = globalThis.fetch; globalThis.fetch = (url, options) => { const target = new URL(url); if (target.origin !== "https://api.cloudflare.com" || options.method !== "GET") throw new Error("Unexpected effect"); return original(new URL(target.pathname, ${JSON.stringify(origin)}), options); };`,
        );
        const child = spawn(
          process.execPath,
          [
            "--import",
            preload,
            new URL("./cloudflare-token-identity-preflight.ts", import.meta.url)
              .pathname,
          ],
          {
            env: {
              ...process.env,
              CLOUDFLARE_API_TOKEN: "fixture",
              CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
              CLOUDFLARE_TOKEN_PERMISSION_REPORT: "true",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout
          .setEncoding("utf8")
          .on("data", (chunk) => (stdout += chunk));
        child.stderr
          .setEncoding("utf8")
          .on("data", (chunk) => (stderr += chunk));
        const [code] = await once(child, "close");
        assert.equal(code, 1);
        assert.equal(stderr, "");
        const records = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(records.length, 2);
        for (const record of records) {
          assert.equal(record.status, "active");
          assert.equal(record.permissionReport.httpStatus, 403);
          assert.equal(record.permissionReport.policyCount, null);
        }
        assert(!stdout.includes("private denial"));
        assert(!stdout.includes(ID));
        assert(!stdout.includes(ACCOUNT));
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("documented optional permission names remain unknown instead of implying absent access", async () => {
  const unnamed = {
    success: true,
    result: {
      id: ID,
      policies: [
        {
          id: "c".repeat(32),
          effect: "allow",
          permission_groups: [{ id: "e".repeat(32) }],
          resources: { "private selector": "*" },
        },
      ],
    },
  };
  await withHttp(
    (request, response) =>
      json(response, request.url?.endsWith("/verify") ? identity : unnamed),
    async (fetchImpl) => {
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token: "fixture",
        fetchImpl,
        includePermissions: true,
      });
      assert.equal(
        result.permissionReport?.failure,
        "permission_names_unavailable",
      );
      assert.equal(result.permissionReport?.policyCount, 1);
      assert.equal(
        result.permissionReport?.observabilityWriteAllowPolicyCount,
        null,
      );
      assert.equal(
        result.permissionReport?.observabilityWriteDenyPolicyCount,
        null,
      );
    },
  );
});
