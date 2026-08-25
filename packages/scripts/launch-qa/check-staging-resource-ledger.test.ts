/**
 * Exercises the staging-resource ledger admission gate against the committed
 * registry and isolated deterministic repositories. The fixtures never
 * resolve private locators or contact providers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
  renderStagingResourceLedgerView,
  serializeStagingResourceLedgerSchema,
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
const fixedNow = new Date("2026-08-25T17:15:00Z");
const sourceLedgerRaw = fs.readFileSync(
  path.join(repoRoot, ledgerRelativePath),
  "utf8",
);
const tempRoots = new Set<string>();
const gitDirectoryResult = spawnSync(
  "git",
  ["-C", repoRoot, "rev-parse", "--absolute-git-dir"],
  { encoding: "utf8", shell: false },
);
if (gitDirectoryResult.status !== 0 || !gitDirectoryResult.stdout.trim()) {
  throw new Error("Tests require the repository Git object database.");
}
const sharedGitDirectory = gitDirectoryResult.stdout.trim();

function resolveGitCommit(revision: string) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "rev-parse", "--verify", `${revision}^{commit}`],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim())) {
    throw new Error(`Could not resolve test Git revision ${revision}.`);
  }
  return result.stdout.trim();
}

function makeTempRoot() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "staging-resource-ledger-gate-"),
  );
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${sharedGitDirectory}\n`);
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
  return checkStagingResourceLedger({
    repoRoot: root,
    now: fixedNow,
  });
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

function opaqueEvidenceRef(prefix: "rct" | "att", seed: string) {
  return `${prefix}-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

function receiptRef(seed: string) {
  return opaqueEvidenceRef("rct", seed);
}

function attestationRef(seed: string) {
  return opaqueEvidenceRef("att", seed);
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
    attestation_ref: attestationRef(`${suffix}-resolver`),
    binding_generation: entry.binding_generation,
    checked_at: observedAt,
  };
  entry.mapping = {
    state: "PASS",
    checked_at: observedAt,
    receipt_ref: receiptRef(`${suffix}-mapping-ready`),
    binding_generation: entry.binding_generation,
  };
  entry.existence = {
    state: "PASS",
    checked_at: observedAt,
    receipt_ref: receiptRef(`${suffix}-existence-ready`),
    binding_generation: entry.binding_generation,
  };
  entry.custody = {
    ...entry.custody,
    primary_state: "ASSIGNED",
    backup_state: "ASSIGNED",
    recovery_role_state: "ASSIGNED",
    mfa_state: "PASS",
    recovery_state: "PASS",
    receipt_ref: receiptRef(`${suffix}-custody-ready`),
    binding_generation: entry.binding_generation,
    checked_at: observedAt,
  };
  entry.configuration = entry.configuration.map((configuration, index) =>
    configuration.authority === "UNRESOLVED"
      ? configuration
      : {
          ...configuration,
          state: "PASS",
          checked_at: observedAt,
          receipt_ref: receiptRef(
            `${suffix}-configuration-${index + 1}-ready`,
          ),
          binding_generation: entry.binding_generation,
        },
  );
  entry.permissions = {
    ...entry.permissions,
    observed_state: "PASS",
    least_privilege_state: "PASS",
    checked_at: observedAt,
    receipt_ref: receiptRef(`${suffix}-permissions-ready`),
    binding_generation: entry.binding_generation,
  };
  entry.isolation = {
    provider_object: "PASS",
    credentials: "PASS",
    data: "PASS",
    runtime: "PASS",
    production_separation: "PASS",
    checked_at: observedAt,
    receipt_ref: receiptRef(`${suffix}-isolation-ready`),
    binding_generation: entry.binding_generation,
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
    receipt_ref: receiptRef(`${suffix}-lifecycle-ready`),
    binding_generation: entry.binding_generation,
  };
  let hasCanonicalNotRequiredEvidence = false;
  for (const kind of ["provider", "runtime", "smoke"]) {
    if (entry.evidence[kind].state === "NOT_REQUIRED") {
      hasCanonicalNotRequiredEvidence = true;
      continue;
    }
    entry.evidence[kind] = {
      state: "PASS",
      receipt_ref: receiptRef(`${suffix}-${kind}-ready`),
      observed_at: observedAt,
      valid_until:
        kind === "smoke" ? "2026-08-25T17:28:55Z" : "2026-08-26T17:00:00Z",
      source_commit:
        kind === "provider"
          ? ledger.snapshot.repository_commit
          : ledger.snapshot.staging_deployment_commit,
      binding_generation: entry.binding_generation,
      reason_code: "CERTIFIED",
    };
  }
  entry.verdict = {
    state: "READY",
    evaluated_at: observedAt,
    reason_codes: [
      "CERTIFIED",
      ...(hasCanonicalNotRequiredEvidence ? ["NOT_REQUIRED"] : []),
    ],
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

  test("projects coverage_key as an exact four-item JSON Schema tuple", () => {
    const schema = JSON.parse(serializeStagingResourceLedgerSchema());
    const coverageKey =
      schema.properties.resources.items.properties.coverage_key;

    expect(coverageKey.minItems).toBe(4);
    expect(coverageKey.maxItems).toBe(4);
    expect(coverageKey.items).toBe(false);
    expect(coverageKey.prefixItems).toHaveLength(4);
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

  test("requires the canonical auth steward and Telegram widget bot dependencies", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0006").relations = [];
    resource(ledger, "qar-0022").relations = resource(
      ledger,
      "qar-0022",
    ).relations.filter(
      (relation) =>
        !(relation.type === "DEPENDS_ON" && relation.ref === "qar-0033"),
    );
    writeLedger(root, ledger);

    const errors = check(root).errors.filter(
      (error) => error.type === "missing-canonical-relation",
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("qar-0015") }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("qar-0033") }),
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
    const repositoryCommit = resolveGitCommit("HEAD");
    const stagingCommit = resolveGitCommit("HEAD~1");
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
    writeLedger(root, ledger);
    deriveArtifacts(root);

    expect(check(root).ok).toBe(true);
  });

  test("rejects arbitrary substitutions in the canonical configuration matrix", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0018").configuration[0].canonical_names = [
      "DISCORD_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ];
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("canonical-configuration-mismatch");
  });

  test("rejects README, fixture, and mock tokens as evidence", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").evidence.provider.receipt_ref =
      "rct-readme-proof";
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("mock-evidence");
  });

  test("rejects OTP-shaped and semantic receipt or attestation aliases", () => {
    for (const { kind, value } of [
      { kind: "receipt", value: "rct-123456" },
      { kind: "attestation", value: "att-123456" },
      { kind: "receipt", value: "rct-provider-proof" },
      { kind: "attestation", value: "att-current-resolver" },
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      const entry = resource(ledger, "qar-0004");
      if (kind === "receipt") {
        entry.mapping.receipt_ref = value;
      } else {
        entry.private_resolver = {
          state: "ATTESTED",
          attestation_ref: value,
          binding_generation: entry.binding_generation,
          checked_at: ledger.snapshot.observed_at,
        };
      }
      writeLedger(root, ledger);

      expect(errorTypes(root)).toContain("schema-validation");
    }
  });

  test("rejects provider-identifier-shaped numeric content in evidence refs", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").mapping.receipt_ref = `rct-${"1".repeat(32)}`;
    resource(ledger, "qar-0005").private_resolver = {
      state: "ATTESTED",
      attestation_ref: `att-${"2".repeat(32)}`,
      binding_generation: 1,
      checked_at: ledger.snapshot.observed_at,
    };
    writeLedger(root, ledger);

    expect(
      errorTypes(root).filter(
        (type) => type === "identifier-shaped-evidence-ref",
      ),
    ).toHaveLength(2);
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

  test("fails READY admission closed until certification and live-deployment authority are external", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "ALIGNED";
    certifyResource(ledger, "qar-0015");
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    const result = check(root);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "external-certification-authority-required",
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: "external-live-attestation-required" }),
    );
    expect(
      result.errors.filter((error) => error.type === "ready-invariant"),
    ).toEqual([]);
  });

  test("lets a freshly revalidated generation 2 reach internal READY coherence while external authorities remain fail-closed", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const candidate = resource(ledger, "qar-0015");
    candidate.binding_generation = 2;
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "ALIGNED";
    certifyResource(ledger, candidate.ref);
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    const result = check(root);
    expect(candidate.verdict.reason_codes).toEqual(["CERTIFIED"]);
    expect(
      result.errors.filter(
        (error) =>
          error.type === "ready-invariant" ||
          error.type === "verdict-reason-state-mismatch",
      ),
    ).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "external-certification-authority-required",
      }),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ type: "external-live-attestation-required" }),
    );
  });

  test("refuses to prepare a signing payload without external authority and live attestation", () => {
    const root = makeTempRoot();
    const ledger = parsedLedger();
    certifyResource(ledger, "qar-0015");
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

    let thrown: unknown;
    try {
      prepareReadyAuthorizationPayload({
        repoRoot: root,
        signedAt,
        validUntil,
        now: new Date(latestObservation + 5 * 60 * 1000),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "external-certification-authority-required",
    );
    expect((thrown as Error).message).toContain(
      "external-live-attestation-required",
    );
    expect((thrown as Error).message).not.toContain("ready-invariant");
  });

  test("refuses to prepare a signing payload for structurally READY but semantically UNKNOWN rows", () => {
    const root = makeTempRoot();
    const ledger = parsedLedger();
    const candidate = resource(ledger, "qar-0015");
    candidate.verdict = {
      state: "READY",
      evaluated_at: ledger.snapshot.observed_at,
      reason_codes: ["CERTIFIED"],
      blocker_issues: [],
    };
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "ALIGNED";
    writeLedger(root, ledger);

    expect(() =>
      prepareReadyAuthorizationPayload({
        repoRoot: root,
        signedAt: "2026-08-25T11:30:00Z",
        validUntil: "2026-08-25T23:30:00Z",
        now: fixedNow,
      }),
    ).toThrow("ready-invariant");
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

  test("requires every declared snapshot and deployment SHA to resolve to a Git commit object", () => {
    for (const [field, expectedPath] of [
      ["repository", "$.snapshot.repository_commit"],
      ["snapshot-deployment", "$.snapshot.staging_deployment_commit"],
      [
        "observed-deployment",
        "$.deployment_observation.staging_deployment_commit",
      ],
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      const nonexistentCommit = "f".repeat(40);
      if (field === "repository") {
        ledger.snapshot.repository_commit = nonexistentCommit;
      } else if (field === "snapshot-deployment") {
        ledger.snapshot.staging_deployment_commit = nonexistentCommit;
      } else {
        ledger.deployment_observation.staging_deployment_commit =
          nonexistentCommit;
      }
      writeLedger(root, ledger);

      expect(check(root).errors).toContainEqual(
        expect.objectContaining({
          type: "unknown-git-commit",
          path: expectedPath,
        }),
      );
    }
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

  test("anchors EVIDENCE_EXPIRED reasons to verdict evaluation time", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const entry = resource(ledger, "qar-0004");
    entry.evidence.provider.valid_until = "2026-08-25T02:00:00Z";
    entry.verdict.reason_codes.push("EVIDENCE_EXPIRED");
    writeLedger(root, ledger);

    expect(check(root).errors).toContainEqual(
      expect.objectContaining({
        type: "verdict-reason-state-mismatch",
        message: expect.stringContaining("Reason code EVIDENCE_EXPIRED"),
      }),
    );
  });

  test("renders evidence and READY authorization validity at the supplied generation time", () => {
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").evidence.provider.valid_until =
      "2026-08-25T10:00:00Z";
    ledger.ready_authorization = {
      ...authorizationMetadata({
        signed_at: "2026-08-25T08:00:00Z",
        valid_until: "2026-08-25T10:00:00Z",
      }),
      payload_sha256: "0".repeat(64),
      signature_base64: Buffer.alloc(64).toString("base64"),
    };

    const beforeExpiry = renderStagingResourceLedgerView(
      ledger,
      new Date("2026-08-25T09:00:00Z"),
    );
    const afterExpiry = renderStagingResourceLedgerView(
      ledger,
      new Date("2026-08-25T12:00:00Z"),
    );
    expect(beforeExpiry).toContain("VALID_UNTIL:2026-08-25T10:00:00Z");
    expect(beforeExpiry).toContain(
      "READY authorization validity: `SIGNED · VALID_UNTIL:2026-08-25T10:00:00Z`",
    );
    expect(afterExpiry).toContain("EXPIRED:2026-08-25T10:00:00Z");
    expect(afterExpiry).toContain(
      "READY authorization validity: `SIGNED · EXPIRED:2026-08-25T10:00:00Z`",
    );
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
        "evidence-source-kind-mismatch",
      ]),
    );
  });

  test("binds provider evidence to source code and runtime/smoke to the deployment", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0004").evidence.provider.source_commit =
      ledger.snapshot.staging_deployment_commit;
    resource(ledger, "qar-0005").evidence.runtime.source_commit =
      ledger.snapshot.repository_commit;
    writeLedger(root, ledger);

    const sourceErrors = check(root).errors.filter(
      (error) => error.type === "evidence-source-kind-mismatch",
    );
    expect(sourceErrors).toHaveLength(2);
    expect(sourceErrors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("evidence.provider.source_commit"),
        expect.stringContaining("evidence.runtime.source_commit"),
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
      binding_generation: first.binding_generation,
    };
    const fourth = resource(ledger, "qar-0004");
    fourth.mapping.receipt_ref = fourth.existence.receipt_ref;
    writeLedger(root, ledger);

    expect(errorTypes(root)).toEqual(
      expect.arrayContaining(["incomplete-receipt", "duplicate-receipt-ref"]),
    );
  });

  test("rejects noncanonical NOT_REQUIRED self-waivers", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0001").mapping = {
      state: "NOT_REQUIRED",
      checked_at: null,
      receipt_ref: null,
      binding_generation: null,
    };
    writeLedger(root, ledger);

    expect(errorTypes(root)).toContain("noncanonical-not-required");
  });

  test("preserves and honors canonical NOT_REQUIRED evidence during READY evaluation", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const ready = certifyResource(ledger, "qar-0004");
    ledger.deployment_observation.staging_deployment_commit =
      ledger.snapshot.staging_deployment_commit;
    ledger.deployment_observation.evidence_alignment = "ALIGNED";
    addInvalidReadyAuthorization(ledger);
    writeLedger(root, ledger);

    expect(ready.evidence.runtime.state).toBe("NOT_REQUIRED");
    expect(ready.verdict.reason_codes).toEqual(["CERTIFIED", "NOT_REQUIRED"]);
    const result = check(root);
    expect(
      result.errors.filter(
        (error) =>
          error.type === "ready-invariant" &&
          error.path.includes("evidence.runtime"),
      ),
    ).toEqual([]);
  });

  test("requires READY-critical receipts to match the current binding generation", () => {
    for (const section of [
      "mapping",
      "existence",
      "configuration",
      "permissions",
      "isolation",
      "lifecycle",
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      const ready = certifyResource(ledger, "qar-0015");
      const receiptSection =
        section === "configuration" ? ready.configuration[0] : ready[section];
      receiptSection.binding_generation = ready.binding_generation + 1;
      addInvalidReadyAuthorization(ledger);
      writeLedger(root, ledger);

      const result = check(root);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          type: "binding-generation-mismatch",
          path: expect.stringContaining(`${section}.`),
        }),
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          type: "ready-invariant",
          path: expect.stringContaining(section),
        }),
      );
    }
  });

  test("requires every neutral or material receipt section to declare its binding generation", () => {
    const missingRoot = makeValidRepo();
    const missingLedger = parsedLedger();
    delete resource(missingLedger, "qar-0003").mapping.binding_generation;
    writeLedger(missingRoot, missingLedger);
    expect(errorTypes(missingRoot)).toContain("schema-validation");

    const materialRoot = makeValidRepo();
    const materialLedger = parsedLedger();
    const material = resource(materialLedger, "qar-0003");
    material.mapping = {
      state: "PRESENT",
      checked_at: materialLedger.snapshot.observed_at,
      receipt_ref: receiptRef("0003-material-null-generation"),
      binding_generation: null,
    };
    writeLedger(materialRoot, materialLedger);
    expect(check(materialRoot).errors).toContainEqual(
      expect.objectContaining({
        type: "incomplete-receipt",
        path: expect.stringContaining("mapping.binding_generation"),
      }),
    );

    const neutralRoot = makeValidRepo();
    const neutralLedger = parsedLedger();
    const neutral = resource(neutralLedger, "qar-0003");
    neutral.mapping.binding_generation = neutral.binding_generation;
    writeLedger(neutralRoot, neutralLedger);
    expect(check(neutralRoot).errors).toContainEqual(
      expect.objectContaining({
        type: "neutral-receipt",
        path: expect.stringContaining("mapping.binding_generation"),
      }),
    );
  });

  test("binds resolver and custody attestations to the current generation", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const first = resource(ledger, "qar-0001");
    first.private_resolver = {
      state: "ATTESTED",
      attestation_ref: attestationRef("0001-resolver-binding"),
      binding_generation: 2,
      checked_at: null,
    };
    const second = resource(ledger, "qar-0002");
    second.custody.primary_state = "ASSIGNED";
    second.custody.receipt_ref = receiptRef("0002-custody-binding");
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

  test("enforces verdict state and reason-code coherence", () => {
    for (const [ref, reasons] of [
      ["qar-0011", ["PARTIAL_EVIDENCE"]],
      ["qar-0007", ["LIFECYCLE_INCOMPLETE"]],
      ["qar-0050", ["MAPPING_MISSING"]],
      ["qar-0001", ["CURRENT_RUNTIME_FAILURE"]],
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      resource(ledger, ref).verdict.reason_codes = reasons;
      writeLedger(root, ledger);

      expect(errorTypes(root)).toContain("verdict-reason-state-mismatch");
    }

    const duplicateRoot = makeValidRepo();
    const duplicateLedger = parsedLedger();
    resource(duplicateLedger, "qar-0001").verdict.reason_codes = [
      "LIFECYCLE_INCOMPLETE",
      "LIFECYCLE_INCOMPLETE",
    ];
    writeLedger(duplicateRoot, duplicateLedger);
    expect(errorTypes(duplicateRoot)).toContain("duplicate-verdict-reason");
  });

  test("rejects verdict reasons that are not supported by current facts", () => {
    const cases = [
      {
        reason: "MAPPING_MISSING",
        mutate(ledger) {
          resource(ledger, "qar-0002").verdict.reason_codes.push(
            "MAPPING_MISSING",
          );
        },
      },
      {
        reason: "MAPPING_MISSING",
        mutate(ledger) {
          resource(ledger, "qar-0003").verdict.reason_codes.push(
            "MAPPING_MISSING",
          );
        },
      },
      {
        reason: "CONFIGURATION_MISSING",
        mutate(ledger) {
          const entry = resource(ledger, "qar-0018");
          entry.configuration[0].state = "PRESENT";
          entry.verdict.reason_codes.push("CONFIGURATION_MISSING");
        },
      },
      {
        reason: "CONFIGURATION_MISSING",
        mutate(ledger) {
          resource(ledger, "qar-0018").verdict.reason_codes.push(
            "CONFIGURATION_MISSING",
          );
        },
      },
      {
        reason: "CUSTODY_INCOMPLETE",
        mutate(ledger) {
          const entry = resource(ledger, "qar-0003");
          entry.custody = {
            ...entry.custody,
            primary_state: "ASSIGNED",
            backup_state: "ASSIGNED",
            recovery_role_state: "ASSIGNED",
            mfa_state: "PASS",
            recovery_state: "PASS",
            receipt_ref: receiptRef("0003-custody-complete"),
            binding_generation: entry.binding_generation,
            checked_at: ledger.snapshot.observed_at,
          };
        },
      },
      {
        reason: "LIFECYCLE_INCOMPLETE",
        mutate(ledger) {
          const entry = resource(ledger, "qar-0003");
          entry.lifecycle = {
            ...entry.lifecycle,
            expiry_state: "TESTED",
            reset_state: "TESTED",
            renewal_state: "TESTED",
            rotation_state: "TESTED",
            revocation_state: "TESTED",
            cleanup_state: "TESTED",
            receipt_ref: receiptRef("0003-lifecycle-complete"),
            binding_generation: entry.binding_generation,
            checked_at: ledger.snapshot.observed_at,
          };
        },
      },
      {
        reason: "EVIDENCE_NOT_COLLECTED",
        mutate(ledger) {
          const entry = certifyResource(ledger, "qar-0015");
          entry.verdict = {
            state: "NOT_READY",
            evaluated_at: ledger.snapshot.observed_at,
            reason_codes: ["EVIDENCE_NOT_COLLECTED"],
            blocker_issues: [25020],
          };
        },
      },
      {
        reason: "RESOURCE_ABSENT",
        mutate(ledger) {
          resource(ledger, "qar-0003").verdict = {
            state: "ABSENT",
            evaluated_at: ledger.snapshot.observed_at,
            reason_codes: ["RESOURCE_ABSENT"],
            blocker_issues: [25020],
          };
        },
      },
      {
        reason: "DEPENDENCY_BLOCKED",
        mutate(ledger) {
          resource(ledger, "qar-0003").verdict = {
            state: "BLOCKED",
            evaluated_at: ledger.snapshot.observed_at,
            reason_codes: ["DEPENDENCY_BLOCKED"],
            blocker_issues: [25020],
          };
        },
      },
      ...[
        "CERTIFICATION_FAILED",
        "ISOLATION_FAILED",
        "BINDING_REPLACED",
        "EVIDENCE_EXPIRED",
      ].map((reason) => ({
        reason,
        mutate(ledger) {
          resource(ledger, "qar-0003").verdict.reason_codes.push(reason);
        },
      })),
    ];

    for (const { reason, mutate } of cases) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      mutate(ledger);
      writeLedger(root, ledger);

      expect(check(root).errors).toContainEqual(
        expect.objectContaining({
          type: "verdict-reason-state-mismatch",
          message: expect.stringContaining(`Reason code ${reason}`),
        }),
      );
    }
  });

  test("does not treat a generic PRESENT mapping as PARTIAL_EVIDENCE", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const entry = resource(ledger, "qar-0003");
    entry.mapping = {
      state: "PRESENT",
      checked_at: ledger.snapshot.observed_at,
      receipt_ref: receiptRef("0003-mapping-present"),
      binding_generation: entry.binding_generation,
    };
    entry.verdict.reason_codes.push("PARTIAL_EVIDENCE");
    writeLedger(root, ledger);

    expect(check(root).errors).toContainEqual(
      expect.objectContaining({
        type: "verdict-reason-state-mismatch",
        message: expect.stringContaining("Reason code PARTIAL_EVIDENCE"),
      }),
    );
  });

  test("keeps structural, dependency, and global authorization failures out of resource reason codes", () => {
    for (const unavailableReason of [
      "EVIDENCE_FAILED",
      "DEPENDENCY_NOT_READY",
      "OWNER_MISSING",
      "ROUTE_INVALID",
      "AUTHORIZATION_MISSING",
      "AUTHORIZATION_INVALID",
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      resource(ledger, "qar-0003").verdict.reason_codes.push(unavailableReason);
      writeLedger(root, ledger);

      expect(errorTypes(root)).toContain("schema-validation");
    }
  });

  test("requires verdict reasons to cover explicit blocking states", () => {
    for (const [ref, removedReason] of [
      ["qar-0001", "ISOLATION_FAILED"],
      ["qar-0014", "MAPPING_MISSING"],
      ["qar-0022", "BINDING_REPLACED"],
      ["qar-0034", "CERTIFICATION_FAILED"],
      ["qar-0050", "DEPENDENCY_BLOCKED"],
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      const entry = resource(ledger, ref);
      entry.verdict.reason_codes = entry.verdict.reason_codes.filter(
        (reason) => reason !== removedReason,
      );
      writeLedger(root, ledger);

      expect(errorTypes(root)).toContain("verdict-reason-state-mismatch");
    }
  });

  test("requires terminal evidence states to drive the verdict state", () => {
    for (const { ref, reasons, expectedMessage } of [
      {
        ref: "qar-0050",
        reasons: ["MAPPING_MISSING"],
        expectedMessage: "Blocked evidence requires a BLOCKED verdict",
      },
      {
        ref: "qar-0014",
        reasons: ["CONFIGURATION_MISSING", "MAPPING_MISSING"],
        expectedMessage: "Absent evidence requires an ABSENT verdict",
      },
      {
        ref: "qar-0034",
        reasons: ["CERTIFICATION_FAILED", "ISOLATION_FAILED"],
        expectedMessage:
          "Failed provider or runtime evidence requires a FAIL verdict",
      },
    ]) {
      const root = makeValidRepo();
      const ledger = parsedLedger();
      const entry = resource(ledger, ref);
      entry.verdict.state = "NOT_READY";
      entry.verdict.reason_codes = reasons;
      writeLedger(root, ledger);

      expect(check(root).errors).toContainEqual(
        expect.objectContaining({
          type: "verdict-reason-state-mismatch",
          message: expect.stringContaining(expectedMessage),
        }),
      );
    }
  });

  test("requires factual NON_CERTIFIABLE evidence to drive checker and writer admission", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    const entry = resource(ledger, "qar-0003");
    entry.evidence.provider = {
      state: "NON_CERTIFIABLE",
      receipt_ref: receiptRef("0003-provider-non-certifiable"),
      observed_at: ledger.snapshot.observed_at,
      valid_until: null,
      source_commit: ledger.snapshot.repository_commit,
      binding_generation: entry.binding_generation,
      reason_code: "NON_CERTIFIABLE_STATE",
    };
    writeLedger(root, ledger);

    const expectedError = expect.objectContaining({
      type: "verdict-reason-state-mismatch",
      message: expect.stringContaining(
        "A factual NON_CERTIFIABLE state requires a NON_CERTIFIABLE verdict",
      ),
    });
    expect(check(root).errors).toContainEqual(expectedError);

    const writeResult = writeStagingResourceLedgerArtifacts({
      repoRoot: root,
      writeSchema: true,
      writeView: true,
      now: fixedNow,
    });
    expect(writeResult.ok).toBe(false);
    expect(writeResult.written).toEqual([]);
    expect(writeResult.errors).toContainEqual(expectedError);
  });

  test("rejects NON_CERTIFIABLE verdicts without a factual basis", () => {
    const root = makeValidRepo();
    const ledger = parsedLedger();
    resource(ledger, "qar-0003").verdict = {
      state: "NON_CERTIFIABLE",
      evaluated_at: ledger.snapshot.observed_at,
      reason_codes: ["NON_CERTIFIABLE_STATE"],
      blocker_issues: [25020],
    };
    writeLedger(root, ledger);

    expect(check(root).errors).toContainEqual(
      expect.objectContaining({
        type: "verdict-reason-state-mismatch",
        message: expect.stringContaining(
          "Reason code NON_CERTIFIABLE_STATE is not supported",
        ),
      }),
    );
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
