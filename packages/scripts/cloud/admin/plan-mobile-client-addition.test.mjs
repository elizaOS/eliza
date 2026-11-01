import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import sodium from "libsodium-wrappers";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  appBindingDigest,
  buildRegistryAddition,
  discoverRegisteredApp,
  planRegistryProvisioning,
  provisionRegistry,
  publishRegistryBinding,
  publishValidatedRegistry,
  REGISTRY_SNAPSHOT_SQL,
  registryDigest,
  sealRegistryPlan,
  trustedGithubKey,
  validatePublishedAppBinding,
  validateRegistryPublication,
  verifyPublishedRegistry,
} from "./plan-mobile-client-addition.ts";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const KEY = "66666666-6666-4666-8666-666666666666";
const OTHER_ORG = "88888888-8888-4888-8888-888888888888";
const OTHER_OWNER = "99999999-9999-4999-8999-999999999999";
const BINDING = { appId: APP, organizationId: ORG, creatorUserId: OWNER };
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
    CREATE TABLE native_app_publishers(organization_id uuid PRIMARY KEY);
      CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean);
    CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,is_active boolean,deleted_at timestamptz,role text);
    CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid,created_by_user_id uuid,is_active boolean,is_approved boolean,app_url text,allowed_origins jsonb,api_key_id uuid,name text,description text,slug text,updated_at timestamptz);
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
    "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved,app_url,allowed_origins,api_key_id) VALUES ($1,$2,$3,true,true,$4,$5,$6)",
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
  assert.deepEqual(await discoverRegisteredApp(readOnly, input), BINDING);
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
    "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved,app_url,allowed_origins,api_key_id) SELECT $1,organization_id,created_by_user_id,is_active,is_approved,app_url,allowed_origins,api_key_id FROM apps",
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
    discoverRegisteredApp(readOnly, { ...input, organizationId: OTHER }),
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

async function useOtherApprovedOwner() {
  await database.query("INSERT INTO organizations VALUES ($1,true)", [
    OTHER_ORG,
  ]);
  await database.query("INSERT INTO users VALUES ($1,$2,true,NULL,'admin')", [
    OTHER_OWNER,
    OTHER_ORG,
  ]);
  await database.query(
    "UPDATE apps SET organization_id=$1,created_by_user_id=$2 WHERE id=$3",
    [OTHER_ORG, OTHER_OWNER, APP],
  );
}

test("a different valid owner requires explicit or canonical app selection", async () => {
  await useOtherApprovedOwner();
  await assert.rejects(
    discoverRegisteredApp(readOnly, input),
    /callback_owner_mismatch/,
  );
  const explicit = { ...input, intendedAppId: APP };
  const binding = await discoverRegisteredApp(readOnly, explicit);
  assert.deepEqual(binding, {
    appId: APP,
    organizationId: OTHER_ORG,
    creatorUserId: OTHER_OWNER,
  });
  const canonical = {
    ...input,
    registry: buildRegistryAddition(input, APP).candidate,
  };
  assert.deepEqual(await discoverRegisteredApp(readOnly, canonical), binding);
  const sealed = await sealRegistryPlan(
    explicit,
    binding,
    "elizaOS/eliza",
    "a".repeat(40),
  );
  assert.equal(sealed.appBindingSha256, appBindingDigest(explicit, binding));
  assert.notEqual(sealed.appBindingSha256, appBindingDigest(explicit, BINDING));
  assert.equal(JSON.stringify(sealed).includes(OTHER_ORG), false);
  assert.equal(JSON.stringify(sealed).includes(OTHER_OWNER), false);
});

test("an explicit product survives creator departure but requires its organization", async () => {
  await useOtherApprovedOwner();
  const explicit = { ...input, intendedAppId: APP };
  const original = await discoverRegisteredApp(readOnly, explicit);
  for (const change of [
    "is_active=false",
    "role='member'",
    `organization_id='${ORG}'`,
  ]) {
    await database.query(`UPDATE users SET ${change} WHERE id=$1`, [
      OTHER_OWNER,
    ]);
    assert.deepEqual(await discoverRegisteredApp(readOnly, explicit), original);
  }
  await database.query("UPDATE apps SET created_by_user_id=NULL WHERE id=$1", [
    APP,
  ]);
  const retained = await discoverRegisteredApp(readOnly, explicit);
  assert.equal(retained.creatorUserId, null);
  assert.equal(
    appBindingDigest(explicit, retained),
    appBindingDigest(explicit, original),
  );
  await database.query("UPDATE organizations SET is_active=false WHERE id=$1", [
    OTHER_ORG,
  ]);
  await assert.rejects(
    discoverRegisteredApp(readOnly, explicit),
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
    BINDING,
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
      appBindingSha256: appBindingDigest(input, BINDING),
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
    assert.deepEqual(await discoverRegisteredApp(readOnly, input), BINDING);
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

for (const environment of ["production", "staging"])
  test(`${environment} seals the candidate and byte-exact rollback to its own GitHub environment key`, async () => {
    const selected = { ...input, environment };
    await sodium.ready;
    // Both environments use the same GitHub key id. Observe the recipient of
    // each real encryption call so a wrong environment key cannot pass on id alone.
    const recipients = [];
    const seal = sodium.crypto_box_seal;
    sodium.crypto_box_seal = (message, publicKey, ...rest) => {
      recipients.push(
        sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL),
      );
      return seal(message, publicKey, ...rest);
    };
    let plan;
    try {
      plan = await sealRegistryPlan(
        selected,
        BINDING,
        "elizaOS/eliza",
        "a".repeat(40),
      );
    } finally {
      sodium.crypto_box_seal = seal;
    }
    assert.deepEqual(
      recipients,
      Array(2).fill(trustedGithubKey("elizaOS/eliza", environment).key),
    );
    const plaintext = buildRegistryAddition(selected, APP);
    assert.equal(plan.candidateSha256, plaintext.candidateSha256);
    assert.equal(plan.sourceSha256, registryDigest(input.registry));
    assert.equal(plan.appBindingSha256, appBindingDigest(selected, BINDING));
    assert.equal(plan.environment, environment);
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
      trustedGithubKey("elizaOS/eliza", environment).key_id,
    );
    assert.equal(plan.rollback.key_id, plan.candidate.key_id);
    assert.notEqual(
      trustedGithubKey("elizaOS/eliza", "staging").key,
      trustedGithubKey("elizaOS/eliza", "production").key,
      "The environment selects different encryption material even when GitHub uses the same key id",
    );
    const artifact = JSON.stringify(plan);
    assert.equal(artifact.includes(APP), false);
    assert.equal(artifact.includes(ORG), false);
    assert.equal(artifact.includes(OWNER), false);
    assert.equal(artifact.includes(retained.clientId), false);
    assert.equal(artifact.includes(retained.redirectUri), false);
    await assert.rejects(
      sealRegistryPlan(
        selected,
        BINDING,
        "attacker/repository",
        "a".repeat(40),
      ),
      /trusted_github_key_unavailable/,
    );
    await assert.rejects(
      sealRegistryPlan(
        { ...selected, environment: "preview" },
        BINDING,
        "elizaOS/eliza",
        "a".repeat(40),
      ),
      /trusted_github_key_unavailable/,
    );
  });

test("publication requires fresh exact bytes, retained entries, and an active organization", async () => {
  const plan = buildRegistryAddition(input, APP);
  const expected = {
    candidateSha256: plan.candidateSha256,
    nonTargetSha256: plan.nonTargetSha256,
    appBindingSha256: appBindingDigest(input, BINDING),
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
  await database.query("UPDATE apps SET created_by_user_id=NULL");
  await validateRegistryPublication(readOnly, fresh, expected);
  await database.query("UPDATE organizations SET is_active=false");
  await assert.rejects(
    validateRegistryPublication(readOnly, fresh, expected),
    /callback_registration_invalid/,
  );
});

test("a changed app identity is refused before publication despite the same callback", async () => {
  const plan = buildRegistryAddition(input, APP);
  const expected = {
    ...plan,
    appBindingSha256: appBindingDigest(input, BINDING),
  };
  const fresh = { ...input, registry: plan.candidate };
  await assert.rejects(
    validateRegistryPublication(readOnly, fresh, {
      ...expected,
      appBindingSha256: appBindingDigest(input, { ...BINDING, appId: OTHER }),
    }),
    /app_binding_mismatch/,
  );
  await database.query("UPDATE apps SET id=$1 WHERE id=$2", [OTHER, APP]);
  await assert.rejects(
    validateRegistryPublication(readOnly, fresh, expected),
    /approved_callback_not_found/,
  );
});

test("changed app or organization cannot reach the Worker update", async () => {
  const plan = buildRegistryAddition(input, APP);
  const expected = {
    ...plan,
    appBindingSha256: appBindingDigest(input, BINDING),
  };
  const fresh = { ...input, registry: plan.candidate };
  let requests = 0;
  const noRequest = async () => {
    requests++;
    throw Error("unexpected Worker request");
  };
  await useOtherApprovedOwner();
  await assert.rejects(
    publishValidatedRegistry(readOnly, fresh, expected, "synthetic", noRequest),
    /app_binding_mismatch/,
  );
  await database.query(
    "UPDATE apps SET organization_id=$1,created_by_user_id=$2 WHERE id=$3",
    [ORG, OWNER, APP],
  );
  await database.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
    ORG,
    OTHER_OWNER,
  ]);
  await database.query("UPDATE apps SET created_by_user_id=$1 WHERE id=$2", [
    OTHER_OWNER,
    APP,
  ]);
  await validateRegistryPublication(readOnly, fresh, expected);
  await database.query("UPDATE apps SET id=$1 WHERE id=$2", [OTHER, APP]);
  await assert.rejects(
    publishValidatedRegistry(readOnly, fresh, expected, "synthetic", noRequest),
    /approved_callback_not_found/,
  );
  assert.equal(requests, 0);
});

test("an explicit or canonical app selector cannot silently choose another callback row", async () => {
  assert.deepEqual(
    await discoverRegisteredApp(readOnly, { ...input, intendedAppId: APP }),
    BINDING,
  );
  await assert.rejects(
    discoverRegisteredApp(readOnly, { ...input, intendedAppId: OTHER }),
    /approved_callback_not_found/,
  );
  const canonical = {
    ...input,
    registry: buildRegistryAddition(input, APP).candidate,
  };
  assert.deepEqual(await discoverRegisteredApp(readOnly, canonical), BINDING);
  await assert.rejects(
    discoverRegisteredApp(readOnly, { ...canonical, intendedAppId: OTHER }),
    /intended_app_mismatch/,
  );
});

test("a new post-publication snapshot detects a changed app binding", async () => {
  const expected = appBindingDigest(
    input,
    await discoverRegisteredApp(readOnly, input),
  );
  await database.query(REGISTRY_SNAPSHOT_SQL);
  await validatePublishedAppBinding(readOnly, input, expected);
  await database.query("ROLLBACK");
  await database.query("UPDATE apps SET id=$1 WHERE id=$2", [OTHER, APP]);
  await database.query(REGISTRY_SNAPSHOT_SQL);
  try {
    await assert.rejects(
      validatePublishedAppBinding(readOnly, input, expected),
      /app_binding_recheck_failed_after_publication/,
    );
  } finally {
    await database.query("ROLLBACK");
  }
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
  assert.match(run(env, "unknown").stderr, /failed invariant=operation\s*$/);
  const wrongBranch = run(
    { ...env, GITHUB_REF: "refs/heads/unreviewed" },
    "provision-primary",
  );
  assert.equal(wrongBranch.status, 1);
  assert.match(wrongBranch.stderr, /failed invariant=protected_branch/);
  assert.equal(wrongBranch.stderr.includes(secret), false);
  for (const operation of [
    "plan-addition",
    "publish-registry",
    "plan-provision",
    "provision-registry",
    "plan-provision-primary",
    "provision-primary",
  ]) {
    const staging = run(
      {
        ...env,
        GITHUB_REF: "refs/heads/staging",
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "staging",
      },
      operation,
    );
    assert.equal(staging.status, 1);
    assert.match(staging.stderr, /failed invariant=operation_failed/);
    assert.equal(staging.stderr.includes(secret), false);
    assert.equal(staging.stdout, "");
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

const NEW_APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function platformFixture() {
  await database.query(
    "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved,app_url,allowed_origins,api_key_id) VALUES ($1,$2,$3,true,true,'https://eliza.app',$4,$5)",
    [
      PRIMARY,
      ORG,
      OWNER,
      JSON.stringify(["https://eliza.app/auth/callback"]),
      KEY,
    ],
  );
  return {
    ...input,
    intendedAppId: NEW_APP,
    redirectUri: "https://cloud.eliza.app/auth/companion/callback",
    displayName: "Companion",
  };
}
const expectedProvision = (plan) => ({
  candidateSha256: plan.candidateSha256,
  nonTargetSha256: plan.nonTargetSha256,
  appBindingSha256: plan.appBindingSha256,
  creationSha256: plan.creationSha256,
});
const writable = {
  async query(text, values) {
    statements.push(text);
    if (text.includes("pg_catalog.pg_control_system()"))
      return { rows: [identity] };
    return database.query(text, values);
  },
};
const makeProvisionPlan = (value) =>
  planRegistryProvisioning(readOnly, value, "elizaOS/eliza", "a".repeat(40));

test("platform plan seals a fixed new UUID under validated protected creation authority without writes", async () => {
  const value = await platformFixture();
  const before = (await database.query("SELECT * FROM apps ORDER BY id")).rows;
  const plan = await makeProvisionPlan(value);
  assert.equal(plan.requiresCreation, true);
  assert.equal(plan.displayName, "Companion");
  assert.equal(plan.sourceSha256, registryDigest(value.registry));
  assert.equal(
    plan.nonTargetSha256,
    registryDigest(JSON.stringify([retained])),
  );
  assert.equal(
    plan.appBindingSha256,
    appBindingDigest(value, { ...BINDING, appId: NEW_APP }),
  );
  assert.match(plan.creationSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes(NEW_APP), false);
  assert.equal(JSON.stringify(plan).includes(OWNER), false);
  assert.deepEqual(
    (await database.query("SELECT * FROM apps ORDER BY id")).rows,
    before,
  );
  await assert.rejects(
    makeProvisionPlan({ ...value, intendedAppId: "" }),
    /intended_app_id_required/,
  );
  await assert.rejects(
    makeProvisionPlan({ ...value, intendedAppId: PRIMARY }),
    /candidate_registry_invalid/,
  );
});

test("platform provisioning creates only the admitted row with public product name and leaves source and old rows intact", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  const before = (await database.query("SELECT * FROM apps ORDER BY id")).rows;
  const source = value.registry;
  statements = [];
  await provisionRegistry(writable, value, expectedProvision(plan));
  const rows = (await database.query("SELECT * FROM apps ORDER BY id")).rows;
  const created = rows.find((row) => row.id === NEW_APP);
  assert.equal(created.name, "Companion");
  assert.equal(created.organization_id, ORG);
  assert.equal(created.created_by_user_id, OWNER);
  assert.deepEqual(created.allowed_origins, [value.redirectUri]);
  assert.equal(created.is_active, true);
  assert.equal(created.is_approved, true);
  assert.match(created.api_key_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(
    rows.filter((row) => row.id !== NEW_APP),
    before,
  );
  assert.equal(
    (await database.query("SELECT count(*)::int AS n FROM api_keys")).rows[0].n,
    0,
  );
  assert.equal(value.registry, source);
  assert.equal(
    statements.filter((sql) => /INSERT INTO apps/.test(sql)).length,
    1,
  );
  assert.equal(
    statements.some((sql) => /UPDATE\s+(apps|api_keys)/.test(sql)),
    false,
  );
  const lock = statements.findIndex((sql) =>
    sql.includes("pg_advisory_xact_lock"),
  );
  const inserted = statements.findIndex((sql) =>
    sql.includes("INSERT INTO apps"),
  );
  assert.ok(lock > 0 && inserted > lock);
  assert.ok(
    statements
      .slice(lock, inserted)
      .some((sql) => sql.includes("pg_catalog.pg_control_system()")),
  );
});

test("a provision retry validates the same row without metadata updates or key revocation", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  await provisionRegistry(writable, value, expectedProvision(plan));
  const snapshot = (await database.query("SELECT * FROM apps ORDER BY id"))
    .rows;
  statements = [];
  await provisionRegistry(writable, value, expectedProvision(plan));
  assert.deepEqual(
    (await database.query("SELECT * FROM apps ORDER BY id")).rows,
    snapshot,
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
  await assert.rejects(
    makeProvisionPlan(value),
    /provision_app_already_exists/,
  );
});

async function configuredAuthorityFixture() {
  const value = await platformFixture();
  await database.query("INSERT INTO organizations VALUES ($1,true)", [
    OTHER_ORG,
  ]);
  await database.query("INSERT INTO users VALUES ($1,$2,true,NULL,'admin')", [
    OTHER_OWNER,
    OTHER_ORG,
  ]);
  return { ...value, organizationId: OTHER_ORG, ownerUserId: OTHER_OWNER };
}

test("platform provisioning uses valid configured creation authority when primary ownership differs", async () => {
  const value = await configuredAuthorityFixture();
  const primary = (
    await database.query("SELECT * FROM apps WHERE id=$1", [PRIMARY])
  ).rows[0];
  const plan = await makeProvisionPlan(value);
  assert.equal(
    plan.appBindingSha256,
    appBindingDigest(value, {
      appId: NEW_APP,
      organizationId: OTHER_ORG,
      creatorUserId: OTHER_OWNER,
    }),
  );
  await provisionRegistry(writable, value, expectedProvision(plan));
  const created = (
    await database.query(
      "SELECT organization_id,created_by_user_id FROM apps WHERE id=$1",
      [NEW_APP],
    )
  ).rows[0];
  assert.deepEqual(created, {
    organization_id: OTHER_ORG,
    created_by_user_id: OTHER_OWNER,
  });
  assert.deepEqual(
    (await database.query("SELECT * FROM apps WHERE id=$1", [PRIMARY])).rows[0],
    primary,
  );
});

test("platform creation requires both configured UUIDs and validates their own authority", async () => {
  const value = await configuredAuthorityFixture();
  for (const changed of [
    { organizationId: "" },
    { ownerUserId: "" },
    { organizationId: "invalid" },
    { ownerUserId: "invalid" },
  ]) {
    await assert.rejects(
      makeProvisionPlan({ ...value, ...changed }),
      /protected_creation_owner_required/,
    );
  }
  for (const [sql, params] of [
    ["UPDATE users SET is_active=false WHERE id=$1", [OTHER_OWNER]],
    ["UPDATE users SET deleted_at=NOW() WHERE id=$1", [OTHER_OWNER]],
    ["UPDATE users SET role='member' WHERE id=$1", [OTHER_OWNER]],
    ["UPDATE users SET organization_id=$1 WHERE id=$2", [ORG, OTHER_OWNER]],
    ["UPDATE organizations SET is_active=false WHERE id=$1", [OTHER_ORG]],
    ["DELETE FROM users WHERE id=$1", [OTHER_OWNER]],
    ["DELETE FROM organizations WHERE id=$1", [OTHER_ORG]],
  ]) {
    await database.query("BEGIN");
    try {
      await database.query(sql, params);
      await assert.rejects(
        makeProvisionPlan(value),
        /protected_creation_authority_invalid/,
      );
    } finally {
      await database.query("ROLLBACK");
    }
  }
});

test("a different valid configured creation authority invalidates the reviewed plan before writes", async () => {
  const other = await configuredAuthorityFixture();
  const value = { ...other, organizationId: ORG, ownerUserId: OWNER };
  const plan = await makeProvisionPlan(value);
  statements = [];
  await assert.rejects(
    provisionRegistry(writable, other, expectedProvision(plan)),
    /provision_plan_mismatch/,
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
});

test("platform planning rejects inactive, unprivileged, cross-org or malformed primary anchors", async () => {
  const value = await platformFixture();
  for (const [sql, params] of [
    ["UPDATE users SET is_active=false WHERE id=$1", [OWNER]],
    ["UPDATE users SET role='member' WHERE id=$1", [OWNER]],
    ["UPDATE users SET organization_id=$1 WHERE id=$2", [OTHER_ORG, OWNER]],
    ["UPDATE apps SET is_approved=false WHERE id=$1", [PRIMARY]],
    ["UPDATE apps SET allowed_origins='[]'::jsonb WHERE id=$1", [PRIMARY]],
  ]) {
    await database.query("BEGIN");
    try {
      await database.query(sql, params);
      await assert.rejects(
        makeProvisionPlan(value),
        /callback_registration_invalid|protected_creation_authority_invalid|authority\./,
      );
    } finally {
      await database.query("ROLLBACK");
    }
  }
});

test("platform planning refuses any callback claimant including an inactive foreign row", async () => {
  const value = await platformFixture();
  await database.query(
    "UPDATE apps SET allowed_origins=$1,is_active=false,is_approved=false WHERE id=$2",
    [JSON.stringify([value.redirectUri]), APP],
  );
  await assert.rejects(makeProvisionPlan(value), /platform_callback_claimed/);
  assert.equal(
    (await database.query("SELECT is_active FROM apps WHERE id=$1", [APP]))
      .rows[0].is_active,
    false,
  );
});

test("platform provisioning rejects mismatching existing UUID rows without repair", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  await database.query("UPDATE apps SET id=$1 WHERE id=$2", [NEW_APP, APP]);
  statements = [];
  await assert.rejects(
    provisionRegistry(writable, value, expectedProvision(plan)),
    /provision_existing_mismatch/,
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
});

test("platform provisioning binds source bytes, non-targets, UUID, name, owner, callback and environment before writes", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  for (const changed of [
    { registry: `${value.registry} ` },
    { registry: JSON.stringify([]) },
    { intendedAppId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { displayName: "Different" },
    { redirectUri: "https://cloud.eliza.app/auth/other/callback" },
    { environment: "staging" },
  ]) {
    statements = [];
    await assert.rejects(
      provisionRegistry(
        writable,
        { ...value, ...changed },
        expectedProvision(plan),
      ),
    );
    assert.equal(
      statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
      false,
    );
  }
  for (const field of Object.keys(expectedProvision(plan))) {
    await assert.rejects(
      provisionRegistry(writable, value, {
        ...expectedProvision(plan),
        [field]: "0".repeat(64),
      }),
      /provision_plan_mismatch/,
    );
  }
  assert.equal(
    (
      await database.query("SELECT count(*)::int AS n FROM apps WHERE id=$1", [
        NEW_APP,
      ])
    ).rows[0].n,
    0,
  );
});

test("platform admission rechecks configured creation authority under the repair lock", async () => {
  const value = await configuredAuthorityFixture();
  const plan = await makeProvisionPlan(value);
  const changedAtLock = {
    async query(sql, params) {
      const result = await writable.query(sql, params);
      if (sql.includes("pg_advisory_xact_lock"))
        await database.query("UPDATE users SET is_active=false WHERE id=$1", [
          OTHER_OWNER,
        ]);
      return result;
    },
  };
  statements = [];
  await assert.rejects(
    provisionRegistry(changedAtLock, value, expectedProvision(plan)),
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
  assert.equal(
    (
      await database.query("SELECT is_active FROM users WHERE id=$1", [
        OTHER_OWNER,
      ])
    ).rows[0].is_active,
    true,
  );
  assert.equal(
    (
      await database.query("SELECT count(*)::int AS n FROM apps WHERE id=$1", [
        NEW_APP,
      ])
    ).rows[0].n,
    0,
  );
});

test("platform admission checks all callback claims again under the repair lock", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  const changedAtLock = {
    async query(sql, params) {
      const result = await writable.query(sql, params);
      if (sql.includes("pg_advisory_xact_lock"))
        await database.query("UPDATE apps SET allowed_origins=$1 WHERE id=$2", [
          JSON.stringify([value.redirectUri]),
          APP,
        ]);
      return result;
    },
  };
  statements = [];
  await assert.rejects(
    provisionRegistry(changedAtLock, value, expectedProvision(plan)),
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
  assert.deepEqual(
    (
      await database.query("SELECT allowed_origins FROM apps WHERE id=$1", [
        APP,
      ])
    ).rows[0].allowed_origins,
    [CALLBACK],
  );
});

test("platform retry refuses a new live generated key rather than revoking it", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  await provisionRegistry(writable, value, expectedProvision(plan));
  const key = (
    await database.query("SELECT api_key_id FROM apps WHERE id=$1", [NEW_APP])
  ).rows[0].api_key_id;
  await database.query("INSERT INTO api_keys VALUES ($1,$2,$3,true,NULL)", [
    key,
    ORG,
    OWNER,
  ]);
  statements = [];
  await assert.rejects(
    provisionRegistry(writable, value, expectedProvision(plan)),
    /callback_registration_invalid/,
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
  assert.equal(
    (await database.query("SELECT is_active FROM api_keys WHERE id=$1", [key]))
      .rows[0].is_active,
    true,
  );
});

test("platform provisioning rejects absent or malformed source and invalid public product metadata", async () => {
  const value = await platformFixture();
  for (const registry of ["", " ", "null", "{}", "not json"])
    await assert.rejects(
      makeProvisionPlan({ ...value, registry }),
      /source_registry_invalid/,
    );
  for (const displayName of [
    "",
    " Companion",
    "Companion\nApp",
    "x".repeat(121),
  ])
    await assert.rejects(
      makeProvisionPlan({ ...value, displayName }),
      /display_name/,
    );
  await assert.rejects(
    makeProvisionPlan({
      ...value,
      redirectUri: "https://unowned.example/auth/companion/callback",
    }),
    /platform_callback/,
  );
  await assert.rejects(
    makeProvisionPlan({ ...value, clusterSha256: "0".repeat(64) }),
    /identity_mismatch/,
  );
});

test("a fresh post-commit snapshot detects changed provisioning metadata without claiming rollback", async () => {
  const value = await platformFixture();
  const plan = await makeProvisionPlan(value);
  const changedAfterCommit = {
    async query(sql, params) {
      const result = await writable.query(sql, params);
      if (sql === "COMMIT")
        await database.query("UPDATE apps SET name='Changed' WHERE id=$1", [
          NEW_APP,
        ]);
      return result;
    },
  };
  await assert.rejects(
    provisionRegistry(changedAfterCommit, value, expectedProvision(plan)),
    /provision_existing_mismatch/,
  );
  assert.equal(
    (await database.query("SELECT name FROM apps WHERE id=$1", [NEW_APP]))
      .rows[0].name,
    "Changed",
  );
});

test("legacy primary provisioning refuses fresh apps without a durable publisher", async () => {
  const value = {
    ...(await platformFixture()),
    provisioningAuthority: "primary",
  };
  statements = [];
  await assert.rejects(makeProvisionPlan(value), /use_publisher_operation/);
  await assert.rejects(
    provisionRegistry(writable, value, {
      candidateSha256: "a".repeat(64),
      nonTargetSha256: "b".repeat(64),
      appBindingSha256: "c".repeat(64),
      creationSha256: "d".repeat(64),
    }),
    /use_publisher_operation/,
  );
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    false,
  );
});
