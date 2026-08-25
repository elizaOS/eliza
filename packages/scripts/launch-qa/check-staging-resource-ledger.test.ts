/**
 * Exercises the staging-resource ledger admission gate against the committed
 * registry and isolated deterministic repositories. The fixtures never
 * resolve private locators or contact providers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
  buildReadyAuthorizationPayload,
  checkStagingResourceLedger,
  prepareReadyAuthorizationPayload,
  verifyReadyAuthorizationSignature,
  writeStagingResourceLedgerArtifacts,
} from "./check-staging-resource-ledger.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ledgerRelativePath = ".github/certification/staging-resources.yaml";
const schemaRelativePath =
  ".github/certification/staging-resources.schema.json";
const viewRelativePath = ".github/certification/staging-resources.md";
const publicKeyRelativePath =
  ".github/certification/certification-public-key.pem";
const publicYamlHeader = `# Public, redacted staging-resource authority. Private locators and evidence
# remain in the separately approved resolver; never add them to this file.\n`;
const fixedNow = new Date("2026-08-25T12:00:00Z");
const sourceLedgerRaw = fs.readFileSync(
  path.join(repoRoot, ledgerRelativePath),
  "utf8",
);
const tempRoots = new Set<string>();

function makeTempRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "staging-resource-ledger-gate-"),
  );
  tempRoots.add(root);
  return root;
}

function writeLedgerRaw(root: string, raw: string) {
  const ledgerPath = path.join(root, ledgerRelativePath);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, raw);
  const keyPath = path.join(root, publicKeyRelativePath);
  if (!fs.existsSync(keyPath)) {
    fs.copyFileSync(path.join(repoRoot, publicKeyRelativePath), keyPath);
  }
}

function writeLedger(root: string, ledger: ReturnType<typeof parse>) {
  writeLedgerRaw(
    root,
    `${publicYamlHeader}${stringify(ledger, { lineWidth: 0 })}`,
  );
}

function deriveArtifacts(root: string) {
  const result = writeStagingResourceLedgerArtifacts({
    repoRoot: root,
    writeSchema: true,
    writeView: true,
    now: fixedNow,
  });
  if (!result.ok) {
    throw new Error(
      `Could not build valid test repository: ${JSON.stringify(result.errors)}`,
    );
  }
}

function makeValidRepo() {
  const root = makeTempRoot();
  writeLedgerRaw(root, sourceLedgerRaw);
  deriveArtifacts(root);
  return root;
}

function check(root: string) {
  return checkStagingResourceLedger({ repoRoot: root, now: fixedNow });
}

function errorTypes(root: string) {
  return check(root).errors.map((error) => error.type);
}

function parsedLedger() {
  return parse(sourceLedgerRaw);
}

function resource(ledger: ReturnType<typeof parse>, ref: string) {
  const found = ledger.resources.find((entry) => entry.ref === ref);
  if (!found) throw new Error(`Missing test resource ${ref}`);
  return found;
}

function authorizationMetadata(
  overrides: Partial<{
    signed_at: string;
    valid_until: string;
  }> = {},
) {
  return {
    payload_version: 1,
    algorithm: "Ed25519",
    key_fingerprint: "3ac9e3e625a9ed2f",
    signed_at: overrides.signed_at ?? "2026-08-25T04:00:00Z",
    valid_until: overrides.valid_until ?? "2026-08-25T18:00:00Z",
  };
}

function certifyResource(
  ledger: ReturnType<typeof parse>,
  ref: string,
  observedAt = "2026-08-24T17:28:55Z",
) {
  const entry = resource(ledger, ref);
  const suffix = ref.slice(-4);
  entry.private_resolver = {
    state: "ATTESTED",
    attestation_ref: `att-${suffix}-resolver`,
    binding_generation: entry.binding_generation,
    checked_at: observedAt,
  };
  entry.mapping = {
    state: "PASS",
    checked_at: observedAt,
    receipt_ref: `rct-${suffix}-mapping-ready`,
  };
  entry.existence = {
    state: "PASS",
    checked_at: observedAt,
    receipt_ref: `rct-${suffix}-existence-ready`,
  };
  entry.custody = {
    ...entry.custody,
    primary_state: "ASSIGNED",
    backup_state: "ASSIGNED",
    recovery_role_state: "ASSIGNED",
    mfa_state: "PASS",
    recovery_state: "PASS",
    receipt_ref: `rct-${suffix}-custody-ready`,
    binding_generation: entry.binding_generation,
    checked_at: observedAt,
  };
  entry.configuration = [
    {
      authority: "GITHUB_ACTIONS",
      canonical_names: [`QA_RESOURCE_${suffix}`],
      state: "PASS",
      checked_at: observedAt,
      receipt_ref: `rct-${suffix}-configuration-ready`,
    },
  ];
  entry.permissions = {
    ...entry.permissions,
    observed_state: "PASS",
    least_privilege_state: "PASS",
    checked_at: observedAt,
    receipt_ref: `rct-${suffix}-permissions-ready`,
  };
  entry.isolation = {
    provider_object: "PASS",
    credentials: "PASS",
    data: "PASS",
    runtime: "PASS",
    production_separation: "PASS",
    checked_at: observedAt,
    receipt_ref: `rct-${suffix}-isolation-ready`,
  };
  entry.lifecycle = {
    reuse_policy: "RESET_BETWEEN_RUNS",
    expiry_state: "TESTED",
    reset_state: "TESTED",
    renewal_state: "TESTED",
    rotation_state: "TESTED",
    revocation_state: "TESTED",
    cleanup_state: "TESTED",
    checked_at: observedAt,
    receipt_ref: `rct-${suffix}-lifecycle-ready`,
  };
  for (const kind of ["provider", "runtime", "smoke"]) {
    entry.evidence[kind] = {
      state: "PASS",
      receipt_ref: `rct-${suffix}-${kind}-ready`,
      observed_at: observedAt,
      valid_until:
        kind === "smoke" ? "2026-08-25T17:00:00Z" : "2026-08-26T17:00:00Z",
      source_commit: ledger.snapshot.repository_commit,
      binding_generation: entry.binding_generation,
      reason_code: "CERTIFIED",
    };
  }
  entry.verdict = {
    state: "READY",
    evaluated_at: observedAt,
    reason_codes: ["CERTIFIED"],
    blocker_issues: [],
  };
  return entry;
}

function addInvalidReadyAuthorization(ledger: ReturnType<typeof parse>) {
  const metadata = authorizationMetadata();
  ledger.ready_authorization = {
    ...metadata,
    payload_sha256: "0".repeat(64),
    signature_base64: Buffer.alloc(64).toString("base64"),
  };
  const built = buildReadyAuthorizationPayload(
    ledger,
    ledger.ready_authorization,
  );
  ledger.ready_authorization.payload_sha256 = built.payloadSha256;
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("staging-resource ledger gate", () => {
  test("accepts the committed 56-row public registry", () => {
    const result = checkStagingResourceLedger({
      repoRoot,
      now: fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.resourceCount).toBe(56);
    expect(result.readyCount).toBe(0);
  });

  test("fails closed when any authoritative artifact is missing", () => {
    for (const relativePath of [
      ledgerRelativePath,
      schemaRelativePath,
      viewRelativePath,
      publicKeyRelativePath,
    ]) {
      const root = makeValidRepo();
      fs.unlinkSync(path.join(root, relativePath));

      expect(check(root).errors).toContainEqual(
        expect.objectContaining({
          type: "missing-artifact",
          path: relativePath,
        }),
      );
    }
  });

  test("rejects symlinked artifacts and symlinked path components", () => {
    const targetRoot = makeTempRoot();
    const targetDirectory = path.join(targetRoot, "outside");
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(
      path.join(targetDirectory, "staging-resources.yaml"),
      sourceLedgerRaw,
    );

    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, ".github"));
    fs.symlinkSync(
      targetDirectory,
      path.join(root, ".github", "certification"),
    );

    expect(check(root).errors).toContainEqual(
      expect.objectContaining({
        type: "unsafe-artifact",
        path: ledgerRelativePath,
      }),
    );
  });

  test("rejects duplicate YAML keys without resolving the document", () => {
    const root = makeValidRepo();
    writeLedgerRaw(
      root,
      sourceLedgerRaw.replace(
        'format: "elizaos-staging-resource-ledger"',
        'format: "elizaos-staging-resource-ledger"\nformat: "elizaos-staging-resource-ledger"',
      ),
    );

    expect(errorTypes(root)).toContain("invalid-yaml");
  });

  test("requires the exact fixed public redaction header", () => {
    const root = makeValidRepo();
    writeLedgerRaw(root, sourceLedgerRaw.split("\n").slice(2).join("\n"));

    expect(errorTypes(root)).toContain("invalid-public-header");
  });

  test("rejects YAML anchors and aliases", () => {
    const root = makeValidRepo();
    const anchored = sourceLedgerRaw.replace(
      'record_state: "TRACKED"',
      'record_state: &tracked "TRACKED"',
    );
    const aliased = anchored.replace(
      'record_state: "TRACKED"',
      "record_state: *tracked",
    );
    writeLedgerRaw(root, aliased);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining(["forbidden-yaml-alias", "forbidden-yaml-anchor"]),
    );
  });

  test("rejects YAML merge keys even without alias expansion", () => {
    const root = makeValidRepo();
    writeLedgerRaw(
      root,
      sourceLedgerRaw.replace(
        '  - ref: "qar-0001"',
        '  - <<: {}\n    ref: "qar-0001"',
      ),
    );

    expect(errorTypes(root)).toContain("forbidden-yaml-merge");
  });

  test("enforces complete coverage and opaque-ref alignment", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const first = resource(ledger, "qar-0001");
    const second = resource(ledger, "qar-0002");
    first.coverage_key = [...second.coverage_key];
    first.profile = second.profile;
    first.kind = second.kind;
    first.surface = second.surface;
    first.purpose = second.purpose;
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "coverage-ref-mismatch",
        "missing-coverage",
        "duplicate-coverage",
      ]),
    );
  });

  test("enforces canonical resource order", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    [ledger.resources[0], ledger.resources[1]] = [
      ledger.resources[1],
      ledger.resources[0],
    ];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("resource-order");
  });

  test("enforces resolved and canonical routing relations", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").relations = [];
    resource(ledger, "qar-0003").relations = [
      { type: "USES", ref: "qar-9999" },
    ];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "missing-canonical-relation",
        "unresolved-relation",
      ]),
    );
  });

  test("enforces exact conversation routes and top-level group ownership", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0043").relations = resource(
      ledger,
      "qar-0043",
    ).relations.filter(
      (relation) =>
        !(relation.type === "ROUTES_TO" && relation.ref === "qar-0054"),
    );
    resource(ledger, "qar-0044").relations.push({
      type: "ROUTES_TO",
      ref: "qar-0053",
    });
    resource(ledger, "qar-0047").relations = resource(
      ledger,
      "qar-0047",
    ).relations.filter((relation) => relation.type !== "OWNED_BY");
    resource(ledger, "qar-0045").relations.push({
      type: "OWNED_BY",
      ref: "qar-0002",
    });
    resource(ledger, "qar-0045").relations = resource(
      ledger,
      "qar-0045",
    ).relations.filter(
      (relation) =>
        !(relation.type === "DEPENDS_ON" && relation.ref === "qar-0044"),
    );
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "routing-contract",
        "group-owner-contract",
        "missing-canonical-relation",
      ]),
    );
  });

  test("enforces exact group ownership and central onboarding capabilities", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0044").permissions.required_capabilities = [
      "CONTROLLED_GROUP",
    ];
    resource(ledger, "qar-0043").permissions.required_capabilities = [
      "CONTROLLED_DIRECT_CONVERSATION",
    ];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("capability-contract");
  });

  test("requires READY dependencies, owners, routes, and children transitively", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    certifyResource(ledger, "qar-0001");
    certifyResource(ledger, "qar-0043");
    certifyResource(ledger, "qar-0044");
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    const relationErrors = check(root).errors.filter(
      (error) =>
        error.type === "ready-invariant" &&
        error.path === "$.resources.0.relations",
    );
    expect(relationErrors).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("qar-0003"),
      }),
    );
    const allMessages = check(root).errors.map((error) => error.message);
    for (const requiredTarget of [
      "qar-0002",
      "qar-0045",
      "qar-0053",
      "qar-0054",
    ]) {
      expect(allMessages).toContainEqual(
        expect.stringContaining(requiredTarget),
      );
    }
  });

  test("rejects unknown schema keys", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").unexpected = "UNKNOWN";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("schema-validation");
  });

  test("detects raw private data without echoing it", () => {
    const root = makeValidRepo();
    writeLedgerRaw(
      root,
      `${sourceLedgerRaw}\n# private contact: qa-person@example.test\n`,
    );
    const result = check(root);

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "privacy-violation",
        message: expect.not.stringContaining("qa-person@example.test"),
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: "forbidden-yaml-comment" }),
    );
  });

  test("rejects every YAML comment beyond the fixed public header", () => {
    for (const forbiddenComment of [
      "# wallet locator: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgJ6V",
      "# discord private locator: opaque-private-value",
    ]) {
      const root = makeValidRepo();
      writeLedgerRaw(root, `${sourceLedgerRaw}\n${forbiddenComment}\n`);
      const result = check(root);

      expect(result.errors).toContainEqual(
        expect.objectContaining({
          type: "forbidden-yaml-comment",
          message: expect.not.stringContaining(forbiddenComment),
        }),
      );
      expect(JSON.stringify(result.errors)).not.toContain(forbiddenComment);
    }
  });

  test("rejects private locator fields and provider locator values", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").private_resolver.provider_id = "redacted";
    resource(ledger, "qar-0002").mapping.receipt_ref =
      "discord://private-channel";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("private-locator");
  });

  test("does not misclassify commit SHAs or generic env names as private data", () => {
    const root = makeTempRoot();
    const ledger = parsedLedger();
    const oldRepositoryCommit = ledger.snapshot.repository_commit;
    const oldStagingCommit = ledger.snapshot.staging_deployment_commit;
    const repositoryCommit = "1".repeat(40);
    const stagingCommit = "2".repeat(40);
    for (const entry of ledger.resources) {
      for (const kind of ["provider", "runtime", "smoke"]) {
        const evidence = entry.evidence[kind];
        if (evidence.source_commit === oldRepositoryCommit) {
          evidence.source_commit = repositoryCommit;
        } else if (evidence.source_commit === oldStagingCommit) {
          evidence.source_commit = stagingCommit;
        }
      }
    }
    ledger.snapshot.repository_commit = repositoryCommit;
    ledger.snapshot.staging_deployment_commit = stagingCommit;
    resource(ledger, "qar-0001").configuration = [
      {
        authority: "GITHUB_ACTIONS",
        canonical_names: ["DISCORD_CLIENT_SECRET", "TELEGRAM_BOT_TOKEN"],
        state: "PRESENT",
        checked_at: ledger.snapshot.observed_at,
        receipt_ref: "rct-0001-configuration-safe",
      },
    ];
    writeLedger(root, ledger);
    deriveArtifacts(root);

    expect(check(root).ok).toBe(true);
  });

  test("rejects README, fixture, and mock tokens as evidence", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").evidence.provider.receipt_ref =
      "rct-readme-proof";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("mock-evidence");
  });

  test("rejects a cosmetic READY verdict with incomplete certification", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const first = resource(ledger, "qar-0001");
    first.verdict.state = "READY";
    first.verdict.reason_codes = ["CERTIFIED"];
    first.verdict.blocker_issues = [];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("ready-invariant");
  });

  test("requires an anchored signature over every READY public claim", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    certifyResource(ledger, "qar-0003");
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "deployment-revalidation-required",
        "invalid-ready-authorization-signature",
      ]),
    );
  });

  test("requires null authorization when no resource is READY", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    ledger.ready_authorization = {
      ...authorizationMetadata(),
      payload_sha256: "0".repeat(64),
      signature_base64: Buffer.alloc(64).toString("base64"),
    };
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("unexpected-ready-authorization");
  });

  test("anchors the committed public key to its hardcoded fingerprint", () => {
    const root = makeValidRepo();
    const { publicKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(
      path.join(root, publicKeyRelativePath),
      publicKey.export({ type: "spki", format: "pem" }),
    );

    expect(errorTypes(root)).toContain("certification-key-anchor");
  });

  test("rejects trailing content after the canonical public key", () => {
    const root = makeValidRepo();
    const { privateKey } = generateKeyPairSync("ed25519");
    fs.appendFileSync(
      path.join(root, publicKeyRelativePath),
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );

    expect(errorTypes(root)).toContain("noncanonical-certification-key");
  });

  test("builds deterministic signed bytes and verifies Ed25519 exactly", () => {
    const ledger = parsedLedger();
    certifyResource(ledger, "qar-0003");
    const metadata = authorizationMetadata();
    const first = buildReadyAuthorizationPayload(ledger, metadata);
    ledger.snapshot = {
      staging_deployment_commit: ledger.snapshot.staging_deployment_commit,
      repository_commit: ledger.snapshot.repository_commit,
      observed_at: ledger.snapshot.observed_at,
    };
    const reordered = buildReadyAuthorizationPayload(ledger, metadata);
    expect(reordered.canonicalJson).toBe(first.canonicalJson);
    expect(reordered.payloadSha256).toBe(first.payloadSha256);
    expect(first.canonicalJson.endsWith("\n")).toBe(false);
    expect(first.payloadSha256).toBe(
      createHash("sha256").update(first.canonicalJson).digest("hex"),
    );

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = signPayload(
      null,
      Buffer.from(first.canonicalJson, "utf8"),
      privateKey,
    ).toString("base64");
    expect(
      verifyReadyAuthorizationSignature({
        canonicalJson: first.canonicalJson,
        signatureBase64: signature,
        publicKey,
      }),
    ).toBe(true);
    expect(
      verifyReadyAuthorizationSignature({
        canonicalJson: `${first.canonicalJson} `,
        signatureBase64: signature,
        publicKey,
      }),
    ).toBe(false);
  });

  test("prepares an operator signing payload without semantic READY admission", () => {
    const root = makeTempRoot();
    const ledger = parsedLedger();
    certifyResource(ledger, "qar-0003");
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "ALIGNED";
    const latestObservation = Math.max(
      Date.parse(ledger.snapshot.observed_at),
      Date.parse(ledger.deployment_observation.observed_at),
    );
    const signedAt = new Date(latestObservation).toISOString();
    const validUntil = new Date(
      latestObservation + 24 * 60 * 60 * 1000,
    ).toISOString();
    writeLedger(root, ledger);

    const prepared = prepareReadyAuthorizationPayload({
      repoRoot: root,
      signedAt,
      validUntil,
      now: new Date(latestObservation + 60 * 60 * 1000),
    });
    expect(prepared.authorization_metadata).toMatchObject({
      payload_version: 1,
      algorithm: "Ed25519",
      key_fingerprint: "3ac9e3e625a9ed2f",
    });
    expect(prepared.authorization_metadata.payload_sha256).toBe(
      createHash("sha256").update(prepared.payload_utf8).digest("hex"),
    );
    expect(prepared.payload_utf8).toContain('"ref":"qar-0003"');
    expect(prepared.payload_utf8.endsWith("\n")).toBe(false);
    expect(
      Buffer.from(prepared.payload_base64, "base64").toString("utf8"),
    ).toBe(prepared.payload_utf8);
  });

  test("rejects future evidence observations", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const evidence = resource(ledger, "qar-0004").evidence.provider;
    evidence.observed_at = "2026-08-26T00:00:00Z";
    evidence.valid_until = "2026-09-26T00:00:00Z";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining(["post-snapshot-timestamp", "future-timestamp"]),
    );
  });

  test("binds deployment alignment to commit and observation order", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "REVALIDATION_REQUIRED";
    ledger.deployment_observation.observed_at = "2026-08-24T16:00:00Z";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "deployment-alignment",
        "stale-deployment-observation",
      ]),
    );
  });

  test("rejects expired and overlong PASS evidence only when READY", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const ready = certifyResource(ledger, "qar-0003");
    ready.evidence.provider.observed_at = "2000-01-01T00:00:00Z";
    ready.evidence.provider.valid_until = "9999-01-01T00:00:00Z";
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    const result = check(root);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "ready-invariant",
        path: expect.stringContaining("evidence.provider.observed_at"),
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "ready-invariant",
        path: expect.stringContaining("evidence.provider.valid_until"),
      }),
    );
  });

  test("keeps expired superseded PASS evidence as visible history", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").evidence.provider.valid_until =
      "2026-08-25T02:00:00Z";
    writeLedger(root, ledger);
    deriveArtifacts(root);

    const result = check(root);
    expect(result.ok).toBe(true);
    const view = fs.readFileSync(path.join(root, viewRelativePath), "utf8");
    expect(view).toContain("HISTORICAL — NOT CURRENT");
    expect(view).toContain("P:PASS·HISTORICAL·EXPIRED");
    expect(view).toContain("NOT READY · FAIL_CURRENT · HISTORICAL");
  });

  test("rejects stale binding generations and source commits", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const evidence = resource(ledger, "qar-0004").evidence.provider;
    evidence.binding_generation = 2;
    evidence.source_commit = "a".repeat(40);
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "binding-generation-mismatch",
        "evidence-source-mismatch",
      ]),
    );
  });

  test("requires coherent dated records and globally unique receipts", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const first = resource(ledger, "qar-0001");
    first.mapping = {
      state: "PRESENT",
      checked_at: null,
      receipt_ref: null,
    };
    const fourth = resource(ledger, "qar-0004");
    fourth.mapping.receipt_ref = fourth.existence.receipt_ref;
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining(["incomplete-receipt", "duplicate-receipt-ref"]),
    );
  });

  test("binds resolver and custody attestations to the current generation", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const first = resource(ledger, "qar-0001");
    first.private_resolver = {
      state: "ATTESTED",
      attestation_ref: "att-0001-resolver",
      binding_generation: 2,
      checked_at: null,
    };
    const second = resource(ledger, "qar-0002");
    second.custody.primary_state = "ASSIGNED";
    second.custody.receipt_ref = "rct-0002-custody-binding";
    second.custody.binding_generation = 2;
    second.custody.checked_at = null;
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining([
        "resolver-attestation",
        "incomplete-receipt",
        "binding-generation-mismatch",
      ]),
    );
  });

  test("requires blockers for non-READY verdicts", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").verdict.blocker_issues = [];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("missing-blocker");
  });

  test("detects JSON Schema and Markdown view drift", () => {
    const schemaRoot = makeValidRepo();
    fs.appendFileSync(path.join(schemaRoot, schemaRelativePath), " \n");
    expect(errorTypes(schemaRoot)).toContain("schema-drift");

    const viewRoot = makeValidRepo();
    fs.appendFileSync(path.join(viewRoot, viewRelativePath), "drift\n");
    expect(errorTypes(viewRoot)).toContain("view-drift");
  });

  test("writes both derived artifacts only after the ledger validates", () => {
    const root = makeTempRoot();
    writeLedgerRaw(root, sourceLedgerRaw);

    const result = writeStagingResourceLedgerArtifacts({
      repoRoot: root,
      writeSchema: true,
      writeView: true,
      now: fixedNow,
    });

    expect(result).toMatchObject({
      ok: true,
      written: [schemaRelativePath, viewRelativePath],
      errors: [],
    });
    expect(check(root).ok).toBe(true);
  });

  test("does not partially write derived artifacts for an invalid ledger", () => {
    const root = makeTempRoot();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").unexpected = "UNKNOWN";
    writeLedger(root, ledger);

    const result = writeStagingResourceLedgerArtifacts({
      repoRoot: root,
      writeSchema: true,
      writeView: true,
      now: fixedNow,
    });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(fs.existsSync(path.join(root, schemaRelativePath))).toBe(false);
    expect(fs.existsSync(path.join(root, viewRelativePath))).toBe(false);
  });

  test("rolls back both derived artifacts when the second publish fails", () => {
    const root = makeValidRepo();
    const schemaPath = path.join(root, schemaRelativePath);
    const viewPath = path.join(root, viewRelativePath);
    fs.appendFileSync(schemaPath, "schema-original-marker\n");
    fs.appendFileSync(viewPath, "view-original-marker\n");
    const originalSchema = fs.readFileSync(schemaPath);
    const originalView = fs.readFileSync(viewPath);
    let publishCount = 0;

    const result = writeStagingResourceLedgerArtifacts({
      repoRoot: root,
      writeSchema: true,
      writeView: true,
      now: fixedNow,
      fileOperations: {
        publishRename(source: string, target: string) {
          publishCount += 1;
          if (publishCount === 2) {
            throw new Error("injected publish failure");
          }
          fs.renameSync(source, target);
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: "artifact-write-failure" }),
    );
    expect(fs.readFileSync(schemaPath)).toEqual(originalSchema);
    expect(fs.readFileSync(viewPath)).toEqual(originalView);
  });

  test("refuses to overwrite a generated-artifact symlink", () => {
    const root = makeTempRoot();
    writeLedgerRaw(root, sourceLedgerRaw);
    const outsidePath = path.join(root, "outside.md");
    const outsideContents = "do not overwrite\n";
    fs.writeFileSync(outsidePath, outsideContents);
    fs.symlinkSync(outsidePath, path.join(root, viewRelativePath));

    const result = writeStagingResourceLedgerArtifacts({
      repoRoot: root,
      writeSchema: true,
      writeView: true,
      now: fixedNow,
    });

    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "unsafe-artifact",
        path: viewRelativePath,
      }),
    );
    expect(fs.readFileSync(outsidePath, "utf8")).toBe(outsideContents);
    expect(fs.existsSync(path.join(root, schemaRelativePath))).toBe(false);
  });
});
