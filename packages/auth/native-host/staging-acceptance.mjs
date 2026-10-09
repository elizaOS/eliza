/** Opt-in protected-runner evidence; never external-provider or device acceptance. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { createNativeCloudAuth } from "./cloud-enrollment.mjs";

const api = "https://api-staging.eliza.app";
const origin = "https://cloud-staging.eliza.app";
const binding = {
  clientId: "ai.elizaos.app",
  environment: "staging",
  redirectUri: "https://eliza.app/auth/callback",
};
const opaque = () => randomBytes(32).toString("base64url");
const challenge = (value) =>
  createHash("sha256").update(value).digest("base64url");
// The staging session exchange takes a 64-char lowercase hex verifier and its
// hex SHA-256 challenge, unlike the RFC 7636 base64url pair the native grant uses.
const sessionOpaque = () => randomBytes(32).toString("hex");
const sessionChallenge = (value) =>
  createHash("sha256").update(value).digest("hex");
const requireValue = (condition) => {
  if (!condition) throw new Error("Native staging acceptance failed");
};

// Explicit protected workflow identity: this fixture cannot run on forks,
// production, ordinary PR jobs, or an arbitrary credentialed developer shell.
function requireProtectedStaging(env, sourceSha) {
  requireValue(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY === "elizaOS/eliza" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/staging" &&
      /^[0-9a-f]{40}$/.test(sourceSha) &&
      env.GITHUB_SHA === sourceSha &&
      env.ELIZA_NATIVE_STAGING_ACCEPTANCE === "1" &&
      env.ELIZAOS_CLOUD_BASE_URL === api,
  );
  const key = env.ELIZAOS_CLOUD_API_KEY?.trim();
  requireValue(key && /^eliza_[0-9a-f]{64}$/.test(key));
  return key;
}

async function main() {
  let step = "admission";
  const checks = {};
  let created;
  let stateDir;
  let vault;
  let Vault;
  let auth;
  const masterKey = randomBytes(32);
  const receipt = {
    schema: "elizaos.native-staging-acceptance/v1",
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    servedSha: null,
    status: "failed",
    failedStep: null,
    checks,
    providerSignInVerified: false,
    physicalDeviceVerified: false,
  };
  const request = async (path, body, token, method) => {
    const response = await fetch(api + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      redirect: "error",
      headers: {
        Accept: "application/json",
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requireValue(
      response.headers.get("content-type")?.includes("application/json"),
    );
    const value = await response.json();
    requireValue(value && typeof value === "object");
    return { status: response.status, value };
  };
  const openVault = () =>
    new Vault({
      dataDir: join(stateDir, "vault"),
      auditPath: join(stateDir, "audit.jsonl"),
      masterKey: {
        load: async () => Buffer.from(masterKey),
        describe: () => "disposable-runner",
      },
    });
  const storage = () => {
    if (!vault) throw new Error("Native staging storage unavailable");
    return vault;
  };
  const read = async (key) => {
    const store = storage();
    return (await store.has(key)) ? store.get(key) : null;
  };
  const createHost = () =>
    createNativeCloudAuth({
      api,
      binding,
      appName: "Eliza staging runner acceptance",
      pendingStore: {
        read: () => read("pending"),
        write: (value) => storage().set("pending", value, { sensitive: true }),
        clear: () => storage().remove("pending"),
      },
      activate: async (secret, guard) => {
        guard();
        await storage().set("active", secret, { sensitive: true });
      },
      readActive: () => read("active"),
      clearActive: () => storage().remove("active"),
    });
  try {
    const key = requireProtectedStaging(process.env, receipt.sourceSha);
    checks.protectedAdmission = true;
    step = "served-health";
    const health = await request("/api/health");
    requireValue(
      health.status === 200 && /^[0-9a-f]{40}$/.test(health.value.commit),
    );
    receipt.servedSha = health.value.commit;
    requireValue(receipt.servedSha === receipt.sourceSha);
    step = "runner-vault";
    ({ PgliteVaultImpl: Vault } = await import("../src/vault/pglite-vault.ts"));
    step = "owned-account";
    const sourceAccount = await request("/api/v1/user", undefined, key);
    requireValue(
      sourceAccount.status === 200 &&
        sourceAccount.value.success === true &&
        typeof sourceAccount.value.id === "string" &&
        typeof sourceAccount.value.organization?.id === "string",
    );
    step = "session-pkce";
    const sessionVerifier = sessionOpaque();
    const mint = await request(
      "/api/auth/staging-session-exchange/mint",
      { codeChallenge: sessionChallenge(sessionVerifier) },
      key,
    );
    requireValue(
      mint.status === 200 &&
        mint.value.ok === true &&
        typeof mint.value.code === "string",
    );
    const session = await request(
      "/api/auth/staging-session-exchange/exchange",
      { code: mint.value.code, codeVerifier: sessionVerifier },
    );
    requireValue(
      session.status === 200 &&
        session.value.ok === true &&
        typeof session.value.token === "string",
    );
    const replay = await request(
      "/api/auth/staging-session-exchange/exchange",
      { code: mint.value.code, codeVerifier: sessionVerifier },
    );
    // The first exchange burned the code, so a replay is an unknown code.
    requireValue(replay.status === 401 && replay.value.code === "invalid_code");
    checks.singleUseSessionPkce = true;
    step = "native-grant";
    const state = opaque();
    const verifier = opaque();
    const grant = await request(
      "/api/v1/app-auth/connect",
      {
        flow: "mobile_pkce",
        ...binding,
        state,
        codeChallenge: challenge(verifier),
        codeChallengeMethod: "S256",
        deviceName: "Protected staging native acceptance",
      },
      session.value.token,
    );
    requireValue(
      grant.status === 200 &&
        grant.value.codeType === "mobile_app_auth_code" &&
        typeof grant.value.code === "string",
    );
    const proof = {
      ...binding,
      state,
      code: grant.value.code,
      codeVerifier: verifier,
    };
    const credential = await request("/api/v1/app-auth/mobile/token", {
      ...proof,
      grantType: "authorization_code",
    });
    requireValue(
      credential.status === 200 &&
        credential.value.acknowledgementRequired === true &&
        credential.value.tokenType === "Bearer" &&
        typeof credential.value.secret === "string" &&
        typeof credential.value.credentialId === "string",
    );
    requireValue(
      credential.value.secret !== key &&
        /^eliza_(?:mobile_)?[0-9a-f]{64}$/.test(credential.value.secret) &&
        /^[0-9a-f-]{36}$/.test(credential.value.credentialId),
    );
    created = {
      secret: credential.value.secret,
      credentialId: credential.value.credentialId,
    };
    checks.nativeGrant = true;
    step = "encrypted-journal";
    stateDir = await mkdtemp(join(tmpdir(), "eliza-native-staging-"));
    vault = openVault();
    await vault.set(
      "pending",
      JSON.stringify({
        version: 1,
        acknowledgeBy: credential.value.acknowledgeBy,
        proof: { ...proof, ...created },
      }),
      { sensitive: true },
    );
    requireValue((await vault.describe("pending"))?.sensitive === true);
    await vault.close();
    vault = openVault();
    auth = createHost();
    step = "native-acknowledgement";
    const result = await auth.handle("resume");
    requireValue(
      result.status === "authenticated" &&
        result.connected === true &&
        !(await vault.has("pending")),
    );
    requireValue((await read("active")) === created.secret);
    checks.encryptedJournalRecovery = true;
    step = "credential-restoration";
    await vault.close();
    vault = openVault();
    auth = createHost();
    requireValue((await read("active")) === created.secret);
    const account = await request(
      "/api/v1/user",
      undefined,
      await read("active"),
    );
    requireValue(
      account.status === 200 &&
        account.value.success === true &&
        account.value.id === sourceAccount.value.id &&
        account.value.organization?.id === sourceAccount.value.organization.id,
    );
    checks.restorationPreservesOwnedAccount = true;
    checks.restoredCredentialAccepted = true;
    requireValue((await auth.billingAuthority()) === null);
    checks.restorationHasNoBillingAuthority = true;
    step = "native-disconnect";
    const cancelled = await auth.cancel({ disconnect: true });
    requireValue(
      cancelled.status === "cancelled" &&
        !(await vault.has("active")) &&
        !(await vault.has("pending")),
    );
    checks.nativeDisconnectReceipt = true;
    receipt.status = "passed";
  } catch {
    // error-policy:J1 emit only the closed phase, never provider bodies or credentials.
    receipt.failedStep = step;
  } finally {
    if (created) {
      // Revoke only the disposable key minted above, even if journal/activation failed.
      // Current-key tombstones make this safe after a successful SDK disconnect.
      try {
        const revoked = await request(
          "/api/v1/api-keys/current",
          undefined,
          created.secret,
          "DELETE",
        );
        requireValue(
          revoked.status === 200 &&
            revoked.value.success === true &&
            revoked.value.status === "revoked" &&
            revoked.value.credentialId === created.credentialId &&
            Number.isFinite(Date.parse(revoked.value.revokedAt)),
        );
        const rejected = await request(
          "/api/v1/user",
          undefined,
          created.secret,
        );
        requireValue(rejected.status === 401);
        checks.createdCredentialRevoked = true;
      } catch {
        // error-policy:J1 keep cleanup failure visible without exposing credential material.
        checks.createdCredentialRevoked = false;
        receipt.status = "failed";
        receipt.failedStep = "created-credential-cleanup";
      }
    }
    try {
      await vault?.close();
      if (stateDir) await rm(stateDir, { recursive: true, force: true });
    } catch {
      // error-policy:J1 a closed receipt still records failed local cleanup.
      receipt.status = "failed";
      receipt.failedStep = "runner-storage-cleanup";
    }
    masterKey.fill(0);
    const output = testOutputPath("native-staging-acceptance", "receipt.json");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      `Native staging credential acceptance: ${receipt.status}; phase=${receipt.failedStep ?? "complete"}. Provider sign-in and physical-device acceptance are separate.`,
    );
    if (receipt.status !== "passed") process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
