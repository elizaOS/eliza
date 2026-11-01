import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  buildRegistryAddition,
  discoverRegisteredApp,
  publishRegistryBinding,
  REGISTRY_SNAPSHOT_SQL,
  registryDigest,
  sealRegistryPlan,
  trustedGithubKey,
  validateRegistryPublication,
  verifyPublishedRegistry,
} from "./plan-mobile-client-addition.ts";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const KEY = "66666666-6666-4666-8666-666666666666";
const CALLBACK = "https://apps.example.org/reader/return";
const clientId = "org.example.reader";
const retained = {
  clientId: "org.example.retained",
  appId: OTHER,
  redirectUri: "https://retained.example.org/return",
  enabled: true,
  credentialTtlSeconds: 86400,
};
const identity = {
  system_identifier: "1234567890123456789",
  database_name: "fixture",
  role_name: "fixture",
  server_version_num: "180001",
};
let database;
let input;
let statements;
const readOnly = {
  async query(text, values) {
    statements.push(text);
    assert.match(text.trim(), /^(SELECT|WITH)\b/);
    assert.doesNotMatch(text, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
    if (text.includes("pg_catalog.pg_control_system()"))
      return { rows: [identity] };
    return database.query(text, values);
  },
};

before(async () => {
  database = await PGlite.create();
  await database.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean);
    CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,is_active boolean,deleted_at timestamptz,role text);
    CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid,created_by_user_id uuid,is_active boolean,is_approved boolean,app_url text,allowed_origins jsonb,api_key_id uuid);
    CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,is_active boolean,deleted_at timestamptz);
  `);
});
beforeEach(async () => {
  statements = [];
  await database.exec("TRUNCATE apps,users,organizations,api_keys");
  await database.query("INSERT INTO organizations VALUES ($1,true)", [ORG]);
  await database.query("INSERT INTO users VALUES ($1,$2,true,NULL,'owner')", [
    OWNER,
    ORG,
  ]);
  await database.query(
    "INSERT INTO apps VALUES ($1,$2,$3,true,true,$4,$5,$6)",
    [
      APP,
      ORG,
      OWNER,
      "https://apps.example.org",
      JSON.stringify([CALLBACK]),
      KEY,
    ],
  );
  const proof = await readDatabaseIdentityReceipt(readOnly, "production");
  input = {
    environment: "production",
    clientId,
    redirectUri: CALLBACK,
    registry: ` [\n${JSON.stringify(retained)}\n] `,
    primaryAppId: PRIMARY,
    organizationId: ORG,
    ownerUserId: OWNER,
    clusterSha256: proof.clusterSha256,
    authoritySha256: proof.authoritySha256,
  };
  statements = [];
});
after(async () => {
  await database.close();
});

test("missing client is planned from the existing approved callback without changing any row", async () => {
  const snapshot = (await database.query("SELECT * FROM apps")).rows;
  assert.equal(await discoverRegisteredApp(readOnly, input), APP);
  const plan = buildRegistryAddition(input, APP);
  assert.equal(plan.changed, true);
  const added = JSON.parse(plan.candidate);
  assert.deepEqual(added[0], retained);
  assert.deepEqual(added[1], {
    clientId,
    appId: APP,
    redirectUri: CALLBACK,
    enabled: true,
  });
  assert.equal(
    plan.nonTargetSha256,
    registryDigest(JSON.stringify([retained])),
  );
  assert.deepEqual((await database.query("SELECT * FROM apps")).rows, snapshot);
});

test("absent or ambiguous approved callbacks never create or select an app", async () => {
  await database.query("UPDATE apps SET is_approved=false");
  await assert.rejects(
    discoverRegisteredApp(readOnly, input),
    /approved_callback_not_found/,
  );
  await database.query("UPDATE apps SET is_approved=true");
  await database.query(
    "INSERT INTO apps SELECT $1,organization_id,created_by_user_id,is_active,is_approved,app_url,allowed_origins,api_key_id FROM apps",
    [OTHER],
  );
  await assert.rejects(
    discoverRegisteredApp(readOnly, input),
    /ambiguous_callback/,
  );
  assert.equal(
    (await database.query("SELECT count(*)::integer AS count FROM apps"))
      .rows[0].count,
    2,
  );
});

test("foreign ownership, extra callback authority and a live generated key are refused", async () => {
  await assert.rejects(
    discoverRegisteredApp(readOnly, { ...input, ownerUserId: OTHER }),
    /callback_owner_mismatch/,
  );
  await database.query("UPDATE apps SET allowed_origins=$1", [
    JSON.stringify([CALLBACK, "https://another.example.org/return"]),
  ]);
  await assert.rejects(
    discoverRegisteredApp(readOnly, input),
    /callback_registration_invalid/,
  );
  await database.query("UPDATE apps SET allowed_origins=$1", [
    JSON.stringify([CALLBACK]),
  ]);
  await database.query("INSERT INTO api_keys VALUES ($1,$2,$3,true,NULL)", [
    KEY,
    ORG,
    OWNER,
  ]);
  await assert.rejects(
    discoverRegisteredApp(readOnly, input),
    /callback_registration_invalid/,
  );
});

test("wrong database identity stops discovery before reading app rows", async () => {
  await assert.rejects(
    discoverRegisteredApp(readOnly, {
      ...input,
      clusterSha256: "0".repeat(64),
    }),
    /identity_mismatch/,
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0], /pg_control_system/);
});

test("existing disabled clients and callback collisions cannot be overwritten by an addition", () => {
  const disabled = {
    ...retained,
    clientId,
    appId: APP,
    redirectUri: CALLBACK,
    enabled: false,
  };
  assert.throws(
    () =>
      buildRegistryAddition(
        { ...input, registry: JSON.stringify([disabled]) },
        APP,
      ),
    /client_already_registered_differently/,
  );
  assert.throws(
    () =>
      buildRegistryAddition(
        {
          ...input,
          registry: JSON.stringify([{ ...retained, redirectUri: CALLBACK }]),
        },
        APP,
      ),
    /candidate_registry_invalid/,
  );
  assert.throws(
    () => buildRegistryAddition({ ...input, registry: "not json" }, APP),
    /source_registry_invalid/,
  );
});

test("already-correct registration canonicalizes whitespace before hashing published bytes", async () => {
  const added = buildRegistryAddition(input, APP);
  const padded = {
    ...input,
    registry: ` \n${JSON.stringify(JSON.parse(added.candidate), null, 2)}\n\t `,
  };
  const plan = buildRegistryAddition(padded, APP);
  assert.equal(plan.added, false);
  assert.equal(plan.changed, true);
  assert.equal(plan.candidate, added.candidate);
  assert.equal(plan.candidate, plan.candidate.trim());
  assert.equal(plan.candidateSha256, registryDigest(plan.candidate.trim()));
  const sealed = await sealRegistryPlan(
    padded,
    APP,
    "elizaOS/eliza",
    "a".repeat(40),
  );
  assert.equal(sealed.sourceSha256, registryDigest(padded.registry));
  assert.equal(
    Buffer.from(sealed.rollback.encrypted_value, "base64").length,
    Buffer.byteLength(padded.registry) + 48,
  );
  await assert.rejects(
    validateRegistryPublication(readOnly, padded, {
      candidateSha256: registryDigest(padded.registry),
      nonTargetSha256: plan.nonTargetSha256,
    }),
    /registry_not_canonical/,
  );
});

test("registry validation uses a repeatable read-only PostgreSQL transaction", async () => {
  await database.query(REGISTRY_SNAPSHOT_SQL);
  try {
    assert.equal(
      (await database.query("SHOW transaction_isolation")).rows[0]
        .transaction_isolation,
      "repeatable read",
    );
    assert.equal(
      (await database.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only,
      "on",
    );
    assert.equal(await discoverRegisteredApp(readOnly, input), APP);
    await assert.rejects(
      database.query("UPDATE users SET is_active=false"),
      /read.only/i,
    );
  } finally {
    await database.query("ROLLBACK");
  }
  assert.equal(
    (await database.query("SELECT is_active FROM users WHERE id=$1", [OWNER]))
      .rows[0].is_active,
    true,
  );
});

test("sealed artifact contains only ciphertext for both candidate and byte-exact rollback", async () => {
  const plan = await sealRegistryPlan(
    input,
    APP,
    "elizaOS/eliza",
    "a".repeat(40),
  );
  const plaintext = buildRegistryAddition(input, APP);
  assert.equal(plan.candidateSha256, plaintext.candidateSha256);
  assert.equal(plan.sourceSha256, registryDigest(input.registry));
  assert.equal(
    Buffer.from(plan.candidate.encrypted_value, "base64").length,
    Buffer.byteLength(plaintext.candidate) + 48,
  );
  assert.equal(
    Buffer.from(plan.rollback.encrypted_value, "base64").length,
    Buffer.byteLength(input.registry) + 48,
  );
  assert.equal(
    plan.candidate.key_id,
    trustedGithubKey("elizaOS/eliza", "production").key_id,
  );
  const artifact = JSON.stringify(plan);
  assert.equal(artifact.includes(APP), false);
  assert.equal(artifact.includes(retained.clientId), false);
  assert.equal(artifact.includes(retained.redirectUri), false);
  await assert.rejects(
    sealRegistryPlan(input, APP, "attacker/repository", "a".repeat(40)),
    /trusted_github_key_unavailable/,
  );
  await assert.rejects(
    sealRegistryPlan(
      { ...input, environment: "staging" },
      APP,
      "elizaOS/eliza",
      "a".repeat(40),
    ),
    /trusted_github_key_unavailable/,
  );
});

test("publication requires fresh exact bytes, retained entries, and a still-approved owner", async () => {
  const plan = buildRegistryAddition(input, APP);
  const expected = {
    candidateSha256: plan.candidateSha256,
    nonTargetSha256: plan.nonTargetSha256,
  };
  const fresh = { ...input, registry: plan.candidate };
  await validateRegistryPublication(readOnly, fresh, expected);
  statements = [];
  await assert.rejects(
    validateRegistryPublication(
      readOnly,
      { ...fresh, registry: `${fresh.registry} ` },
      expected,
    ),
    /candidate_hash_mismatch/,
  );
  assert.equal(
    statements.length,
    0,
    "stale bytes are refused before any database request",
  );
  await assert.rejects(
    validateRegistryPublication(readOnly, fresh, {
      ...expected,
      nonTargetSha256: "0".repeat(64),
    }),
    /non_target_hash_mismatch/,
  );
  await database.query("UPDATE users SET is_active=false");
  await assert.rejects(
    validateRegistryPublication(readOnly, fresh, expected),
    /callback_registration_invalid/,
  );
});

test("CLI failures hide provider configuration and refuse an unprotected branch", () => {
  const secret = "synthetic-password-that-must-not-be-logged";
  const env = {
    PATH: process.env.PATH,
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "elizaOS/eliza",
    GITHUB_REF: "refs/heads/main",
    ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
    DATABASE_URL: `https://owner:${secret}@database.invalid/db`,
  };
  const run = (variables, operation = "plan-addition") =>
    spawnSync(
      process.execPath,
      [
        new URL("./plan-mobile-client-addition.ts", import.meta.url).pathname,
        operation,
      ],
      { env: variables, encoding: "utf8" },
    );
  const failed = run(env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /failed invariant=operation_failed/);
  assert.equal(failed.stderr.includes(secret), false);
  assert.equal(failed.stdout, "");
  const wrongBranch = run({ ...env, GITHUB_REF: "refs/heads/unreviewed" });
  assert.equal(wrongBranch.status, 1);
  assert.match(wrongBranch.stderr, /failed invariant=protected_branch/);
  assert.equal(wrongBranch.stderr.includes(secret), false);
  for (const operation of ["plan-addition", "publish-registry"]) {
    const staging = run(
      {
        ...env,
        GITHUB_REF: "refs/heads/staging",
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "staging",
      },
      operation,
    );
    assert.equal(staging.status, 1);
    assert.match(staging.stderr, /trusted_github_key_unavailable/);
  }
});

test("post-publication verifies the primary and all enabled clients, with redacted failure", async () => {
  const plan = buildRegistryAddition(input, APP);
  const fresh = {
    ...input,
    registry: JSON.stringify([
      ...JSON.parse(plan.candidate),
      {
        clientId: "org.example.disabled",
        appId: "77777777-7777-4777-8777-777777777777",
        redirectUri: "https://disabled.example.org/return",
        enabled: false,
      },
    ]),
  };
  const calls = [];
  const fetchImpl = async (value) => {
    const url = new URL(value);
    calls.push(url.searchParams.get("clientId"));
    const response = new Response(
      JSON.stringify({
        success: true,
        clientId: url.searchParams.get("clientId"),
        environment: "production",
        redirectUri: url.searchParams.get("redirectUri"),
        codeChallengeMethod: "S256",
        scopes: ["cloud:user"],
        app: {
          name: "Fixture",
          description: null,
          logoUrl: null,
          websiteUrl: null,
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  assert.equal(await verifyPublishedRegistry(fresh, fetchImpl), 3);
  assert.deepEqual(
    calls.sort(),
    ["ai.elizaos.app", clientId, retained.clientId].sort(),
  );
  await assert.rejects(
    verifyPublishedRegistry(fresh, async (url, options) => {
      if (new URL(url).searchParams.get("clientId") === retained.clientId)
        throw Error("private-provider-details");
      return fetchImpl(url, options);
    }),
    (error) =>
      error.message === "public_registry_verification_failed_after_publication",
  );
});

test("secret publication uses the existing exact Worker and preserves the supplied text", async () => {
  const calls = [];
  await publishRegistryBinding(
    input,
    "synthetic-token",
    async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-token");
      if (options.method !== "PUT")
        return Response.json({
          success: true,
          result: [{ name: "existing", type: "secret_text" }],
        });
      assert.deepEqual(JSON.parse(options.body), {
        name: "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
        text: input.registry,
        type: "secret_text",
      });
      return Response.json({
        success: true,
        result: {
          name: "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
          type: "secret_text",
        },
      });
    },
  );
  assert.equal(calls.length, 2);
  for (const call of calls)
    assert.equal(
      call.url,
      "https://api.cloudflare.com/client/v4/accounts/23cf6feaeaa541f6a0675053c33da768/workers/scripts/eliza-cloud-api-prod/secrets",
    );
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[1].options.method, "PUT");
});

test("missing Worker and redirects never trigger a secret PUT or leak provider bodies", async () => {
  for (const status of [404, 302, 403]) {
    const methods = [];
    await assert.rejects(
      publishRegistryBinding(
        input,
        "synthetic-token",
        async (_url, options) => {
          methods.push(options.method ?? "GET");
          assert.equal(options.redirect, "error");
          return new Response("private-provider-details", {
            status,
            headers: { Location: "https://outside.invalid/" },
          });
        },
      ),
      (error) =>
        error.message ===
        (status === 404
          ? "worker_not_found"
          : "worker_preflight_not_confirmed"),
    );
    assert.deepEqual(methods, ["GET"]);
  }
  const methods = [];
  await assert.rejects(
    publishRegistryBinding(input, "synthetic-token", async (_url, options) => {
      methods.push(options.method ?? "GET");
      assert.equal(options.redirect, "error");
      return options.method === "PUT"
        ? new Response("private-provider-details", { status: 307 })
        : Response.json({ success: true, result: [] });
    }),
    /worker_registry_publication_not_confirmed/,
  );
  assert.deepEqual(methods, ["GET", "PUT"]);
});
