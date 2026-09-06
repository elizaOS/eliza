/**
 * Exercises verification through controlled HTTP responses and executes the trusted
 * workflow's shell entry point with a network-denying verification fixture.
 * No real credentials, Cloudflare requests, or model requests are used.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runTokenIdentityPreflight,
  verifyTokenIdentity,
} from "./cloudflare-token-identity-preflight.mjs";

const id = "a".repeat(32);
const accountId = "b".repeat(32);
const token = "synthetic-only-token";
const secretMarker = "UPSTREAM_PRIVATE_TEXT";
const digest = createHash("sha256").update(id).digest("hex");
const success = (status = "active") => ({
  success: true,
  result: { id, status },
  messages: [secretMarker],
  extra: token,
});

describe("Cloudflare token identity HTTP boundary", () => {
  for (const endpoint of ["user", "account"]) {
    for (const status of ["active", "disabled", "expired"]) {
      test(`${endpoint} ${status} emits only verified metadata digest`, async () => {
        let calls = 0;
        const result = await verifyTokenIdentity({
          endpoint,
          token,
          accountId,
          fetchImpl: async (url, init) => {
            calls++;
            expect(url).toBe(
              endpoint === "user"
                ? "https://api.cloudflare.com/client/v4/user/tokens/verify"
                : `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
            );
            expect(init.method).toBe("GET");
            expect(init.redirect).toBe("error");
            expect(init.headers.Authorization).toBe(`Bearer ${token}`);
            expect(init.signal).toBeInstanceOf(AbortSignal);
            return Response.json(success(status));
          },
        });
        expect(result).toEqual({
          endpoint,
          httpStatus: 200,
          failure: null,
          status,
          tokenIdSha256: digest,
        });
        expect(calls).toBe(1);
        for (const privateValue of [id, token, accountId, secretMarker])
          expect(JSON.stringify(result)).not.toContain(privateValue);
      });
    }
  }
  test("invalid and adversarial envelopes never produce an identity digest", async () => {
    for (const body of [
      "{",
      "null",
      "[]",
      JSON.stringify({ success: false, result: { id, status: "active" } }),
      ...[
        "short",
        "A".repeat(32),
        "0".repeat(33),
        secretMarker,
        "../account",
        null,
        123,
      ].map((badId) =>
        JSON.stringify({
          success: true,
          result: { id: badId, status: "active" },
        }),
      ),
      JSON.stringify({ success: true, result: { id, status: secretMarker } }),
    ]) {
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token,
        fetchImpl: async () => new Response(body),
      });
      expect(result).toEqual({
        endpoint: "user",
        httpStatus: 200,
        failure: "invalid_response",
        status: null,
        tokenIdSha256: null,
      });
    }
  });
  test("denial and redirect bodies are never consumed or followed", async () => {
    for (const status of [301, 302, 403, 500]) {
      let calls = 0;
      const result = await verifyTokenIdentity({
        endpoint: "account",
        token,
        accountId,
        fetchImpl: async (_url, init) => {
          calls++;
          expect(init.redirect).toBe("error");
          return new Response(secretMarker, {
            status,
            headers: { Location: "https://untrusted.example.test" },
          });
        },
      });
      expect(result.failure).toBe("http_error");
      expect(result.httpStatus).toBe(status);
      expect(result.tokenIdSha256).toBeNull();
      expect(JSON.stringify(result)).not.toContain(secretMarker);
      expect(calls).toBe(1);
    }
  });
  test("network errors, oversized bodies and body deadlines are sanitized", async () => {
    const scenarios = [
      {
        failure: "request_failed",
        fetchImpl: async () => {
          throw new Error(secretMarker);
        },
      },
      {
        failure: "response_too_large",
        fetchImpl: async () => new Response("x".repeat(16_385)),
      },
      {
        failure: "timeout",
        fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
      },
    ];
    for (const scenario of scenarios) {
      let calls = 0;
      const result = await verifyTokenIdentity({
        endpoint: "user",
        token,
        deadlineMs: 10,
        fetchImpl: async () => {
          calls++;
          return scenario.fetchImpl();
        },
      });
      expect(result.failure).toBe(scenario.failure);
      expect(result.tokenIdSha256).toBeNull();
      expect(JSON.stringify(result)).not.toContain(secretMarker);
      expect(calls).toBe(1);
    }
  });
  test("invalid account configuration cannot become a URL or network request", async () => {
    let calls = 0;
    const result = await verifyTokenIdentity({
      endpoint: "account",
      token,
      accountId: "../invalid",
      fetchImpl: async () => {
        calls++;
        throw new Error("Unexpected request");
      },
    });
    expect(result.failure).toBe("invalid_configuration");
    expect(calls).toBe(0);
  });
  test("preflight independently attempts only the two fixed verification GETs", async () => {
    const calls = [];
    const results = await runTokenIdentityPreflight({
      token,
      accountId,
      fetchImpl: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? new Response(secretMarker, { status: 403 })
          : Response.json(success());
      },
    });
    expect(calls).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
    ]);
    expect(results[0].failure).toBe("http_error");
    expect(results[1].tokenIdSha256).toBe(digest);
  });
});

test("protected dispatch selection executes zero-model preflight and refuses arbitrary source", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const workflow = Bun.YAML.parse(
    await readFile(
      join(root, ".github/workflows/cloud-latency-certification.yml"),
      "utf8",
    ),
  );
  function admitted(condition, flag, ref) {
    const expression = condition
      .replace(/^\$\{\{\s*/, "")
      .replace(/\s*\}\}$/, "")
      .replaceAll("inputs.token_identity_preflight", String(flag))
      .replaceAll("github.ref", JSON.stringify(ref));
    return Function(`return (${expression})`)();
  }
  const jobs = Object.entries(workflow.jobs);
  expect(
    jobs
      .filter(([, job]) => admitted(job.if, true, "refs/heads/develop"))
      .map(([name]) => name),
  ).toEqual(["token-identity-preflight"]);
  expect(
    jobs
      .filter(([, job]) => admitted(job.if, true, "refs/heads/untrusted"))
      .map(([name]) => name),
  ).toEqual([]);
  expect(
    jobs
      .filter(([, job]) => admitted(job.if, false, "refs/heads/develop"))
      .map(([name]) => name),
  ).toEqual(["certify-staging"]);
  const job = workflow.jobs["token-identity-preflight"];
  expect(job.environment).toBe("staging");
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout.with.ref).toBe(`\${{ github.sha }}`);
  expect(checkout.with["persist-credentials"]).toBe(false);
  const scripts = job.steps.filter((step) => step.run);
  expect(scripts.flatMap((step) => Object.keys(step.env ?? {})).sort()).toEqual(
    ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  );
  const directory = await mkdtemp(
    join(tmpdir(), "eliza-token-preflight-test-"),
  );
  const preload = join(directory, "http-fixture.mjs");
  await writeFile(
    preload,
    `
let calls = 0;
let unexpected = false;
globalThis.fetch = async (url, init) => {
  calls++;
  const allowed = ['https://api.cloudflare.com/client/v4/user/tokens/verify', 'https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify'];
  if (!allowed.includes(String(url)) || init.method !== 'GET' || init.redirect !== 'error') {
    unexpected = true;
    throw new Error('Unexpected network request');
  }
  return Response.json(${JSON.stringify(success())});
};
process.on('beforeExit', () => { if (calls !== 2 || unexpected) process.exitCode = 1; });
`,
  );
  const shell = scripts.map((step) => step.run).join("\n");
  const env = {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--import=${preload}`,
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
  const accepted = spawnSync("bash", ["-c", shell], {
    cwd: root,
    env: { ...env, GITHUB_REF: "refs/heads/develop" },
    encoding: "utf8",
  });
  expect(accepted.status).toBe(0);
  expect(accepted.stderr).toBe("");
  const records = accepted.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((item) => item.endpoint)).toEqual(["user", "account"]);
  expect(records.every((item) => item.tokenIdSha256 === digest)).toBe(true);
  for (const privateValue of [id, token, accountId, secretMarker])
    expect(accepted.stdout).not.toContain(privateValue);
  const rejected = spawnSync("bash", ["-c", shell], {
    cwd: root,
    env: { ...env, GITHUB_REF: "refs/heads/untrusted" },
    encoding: "utf8",
  });
  expect(rejected.status).toBe(1);
  expect(rejected.stdout).not.toContain(digest);
  const paidGate = workflow.jobs["certify-staging"].steps.find(
    (step) => step.run,
  ).run;
  const missingSha = spawnSync("bash", ["-c", paidGate], {
    env: {
      PATH: process.env.PATH,
      EXPECTED_DEPLOY_SHA: "",
      GITHUB_REF: "refs/heads/develop",
    },
    encoding: "utf8",
  });
  expect(missingSha.status).toBe(1);
  expect(missingSha.stdout).toContain("expected_deploy_sha");
});
