// Shared APK release-row judgement and in-place update comparison, on synthetic rows and
// device-shell outputs. These are refusals and parsers, not an install on a device.
import assert from "node:assert/strict";
import test from "node:test";
import {
  apkReleaseBlockers,
  apkUpdateAdmission,
  compareDomains,
  DOMAIN_SCRIPT,
  inPlaceUpdateFailures,
  integrityQuery,
  parseDomainInventory,
  parseIntegrityExport,
  readbackInventory,
} from "../android/apk-release-record.mjs";

const row = (overrides = {}) => ({
  mode: "release",
  testMocks: false,
  bundleAudit: "passed",
  signed: true,
  releaseAdmission: { failures: [], blockers: [], signerMatches: true },
  runtime: "PACKAGED",
  runtimeNotices: true,
  voiceHost: { packaged: true, differences: [], qualified: true },
  licenceBlockers: [],
  distributable: true,
  ...overrides,
});

test("a complete distributable release row has no blockers", () => {
  assert.deepEqual(apkReleaseBlockers(row()), []);
});

test("every recorded or missing fact is named", () => {
  const blockers = apkReleaseBlockers(
    row({
      testMocks: true,
      bundleAudit: "failed",
      signed: false,
      runtime: "UNPACKAGED",
      voiceHost: { packaged: true, differences: ["libx.so"], qualified: false },
      licenceBlockers: undefined,
    }),
    { manifestTestMocks: true },
  );
  for (const expected of [
    "test-mocks build",
    "release did not pass the flag-off bundle audit",
    "unsigned release",
    "unpackaged runtime (resident runtime UNPACKAGED)",
    "unqualified on-device voice (bytes differ from the voice-host record, device qualification pending)",
    "font licence check was not recorded",
  ])
    assert.ok(blockers.includes(expected), expected);
  assert.deepEqual(apkReleaseBlockers(row({ runtimeNotices: false })), [
    "notices lack the packaged runtime",
  ]);
  assert.deepEqual(apkReleaseBlockers(row({ voiceHost: undefined })), [
    "on-device voice admission was not recorded",
  ]);
  assert.deepEqual(
    apkReleaseBlockers(row({ voiceHost: { packaged: false } })),
    ["no on-device voice packaged (local speech would be unavailable)"],
  );
  assert.deepEqual(apkReleaseBlockers(row({ releaseAdmission: undefined })), [
    "release signing admission was not recorded",
  ]);
  assert.deepEqual(apkReleaseBlockers(row({ distributable: false })), [
    "verify-apks did not record this release as distributable",
  ]);
});

test("the product signer policy recomputes admission and an unset signer blocks", () => {
  const admitSigner = (_row, signer) => {
    if (!signer?.certificateSha256) throw new Error("release signer is unset");
    return {
      failures: [],
      blockers: [],
      signerMatches: signer.certificateSha256 === "a".repeat(64),
    };
  };
  assert.deepEqual(
    apkReleaseBlockers(row(), {
      releaseSigner: { certificateSha256: "a".repeat(64) },
      admitSigner,
    }),
    [],
  );
  assert.deepEqual(
    apkReleaseBlockers(row(), { releaseSigner: {}, admitSigner }),
    ["release signer is unset"],
  );
  assert.deepEqual(
    apkReleaseBlockers(row(), {
      releaseSigner: { certificateSha256: "b".repeat(64) },
      admitSigner,
      signerFile: "android/release-signer.json",
    }),
    ["release signer does not match android/release-signer.json"],
  );
  assert.throws(
    () => apkReleaseBlockers(row(), { releaseSigner: {} }),
    /admitSigner/,
  );
});

test("licence flags never block; only the product's named check can", () => {
  const flagged = row({
    licenceFlags: [
      "copyleft-strong",
      "unknown-licence",
      "non-open-source-terms",
    ],
    licenceBlockers: ["unresolved-font-licence: Display", "copyleft: x"],
  });
  assert.deepEqual(apkReleaseBlockers(flagged), []);
  assert.deepEqual(
    apkReleaseBlockers(flagged, {
      licenceBlocks: (item) => /^unresolved-font-licence: /.test(item),
    }),
    ["unresolved-font-licence: Display"],
  );
});

test("the image platform certificate must be a reviewed digest", () => {
  assert.match(
    apkReleaseBlockers(row(), { image: {} }).join("\n"),
    /image platform certificate is null/,
  );
  assert.deepEqual(
    apkReleaseBlockers(row(), {
      image: { platformCertificateSha256: "c".repeat(64) },
    }),
    [],
  );
});

test("an in-place update keeps the signer and raises the versionCode", () => {
  const signer = "a".repeat(64);
  assert.deepEqual(
    apkUpdateAdmission({
      installedVersionCode: 3,
      installedSigner: signer,
      newVersionCode: 4,
      newSigner: signer,
    }),
    [],
  );
  assert.match(
    apkUpdateAdmission({
      installedVersionCode: 4,
      installedSigner: signer,
      newVersionCode: 4,
      newSigner: signer,
    }).join(),
    /must be greater/,
  );
  assert.match(
    apkUpdateAdmission({
      installedVersionCode: 3,
      installedSigner: signer,
      newVersionCode: 4,
      newSigner: "b".repeat(64),
    }).join(),
    /differs from the installed/,
  );
  assert.match(
    apkUpdateAdmission({
      installedVersionCode: 3,
      installedSigner: null,
      newVersionCode: 4,
      newSigner: signer,
    }).join(),
    /installed unknown/,
  );
});

test("per-domain readback compares every file and refuses failed walks", () => {
  const a = "1".repeat(64);
  const b = "2".repeat(64);
  const output = `${a}  ./files/state.json\n${b}  ./databases/app.db\n${a}  ./root.txt\nREADBACK_EXIT=0\n`;
  const before = readbackInventory(output);
  assert.deepEqual(before, {
    files: { "files/state.json": a },
    databases: { "databases/app.db": b },
    ".": { "root.txt": a },
  });
  assert.equal(readbackInventory("run-as: package not debuggable: x"), null);
  assert.throws(() => readbackInventory(`${a}  ./files/x\n`), /exit missing/);
  assert.throws(() => readbackInventory("READBACK_EXIT=1\n"), /exit 1/);
  const after = parseDomainInventory(
    `${b}  ./files/state.json\n${a}  ./files/new\n`,
  );
  assert.deepEqual(compareDomains(before, after), [
    "databases/app.db was lost",
    "files/new appeared",
    "files/state.json changed",
    "root.txt was lost",
  ]);
  assert.match(DOMAIN_SCRIPT, /READBACK_EXIT=\$\?/);
  assert.doesNotMatch(DOMAIN_SCRIPT, /'/);
});

test("the integrity export is parsed whole or refused", () => {
  const nonce = "0".repeat(64);
  assert.deepEqual(
    integrityQuery("com.example.app.integrity", nonce).slice(-1),
    [`'content://com.example.app.integrity/domains?nonce=${nonce}'`],
  );
  assert.throws(() => integrityQuery("com.example; rm", nonce), /authority/);
  assert.throws(() => integrityQuery("com.example.app", "xyz"), /nonce/);
  const key = "a".repeat(64);
  const digest = "b".repeat(64);
  const text = `Row: 0 domain=files, key=${key}, digest=${digest}\nRow: 1 domain=#end, key=1, digest=${"0".repeat(64)}\n`;
  assert.deepEqual(parseIntegrityExport(text), {
    files: { [`files/${key}`]: digest },
  });
  assert.equal(parseIntegrityExport("Error: Could not find provider"), null);
  assert.throws(
    () => parseIntegrityExport("Permission Denial: x"),
    /export failed/,
  );
  assert.throws(
    () =>
      parseIntegrityExport(
        `Row: 0 domain=files, key=${key}, digest=${digest}\n`,
      ),
    /truncated/,
  );
  assert.throws(
    () =>
      parseIntegrityExport(
        `Row: 0 domain=files, key=${key}, digest=${digest}\nRow: 1 domain=#end, key=2, digest=${digest}\n`,
      ),
    /end row says 2/,
  );
});

test("in-place update failures name identity, bytes and data changes", () => {
  const apk = { sha256: "a".repeat(64), versionCode: 5 };
  const before = { userId: 10100, firstInstallTime: "t0", versionCode: 4 };
  const domains = { files: { "files/x": "1".repeat(64) } };
  assert.deepEqual(
    inPlaceUpdateFailures({
      apk,
      before,
      after: { ...before, versionCode: 5 },
      installedSha256: apk.sha256,
      domainsBefore: domains,
      domainsAfter: domains,
    }),
    [],
  );
  assert.deepEqual(
    inPlaceUpdateFailures({
      apk,
      before,
      after: { userId: 1, firstInstallTime: "t1", versionCode: 4 },
      installedSha256: "b".repeat(64),
      domainsBefore: {},
      domainsAfter: {},
    }),
    [
      "installed bytes differ from the admitted APK",
      "installed versionCode 4 is not 5",
      "package uid changed (data would be unreachable)",
      "first-install time changed (the update replaced the install)",
      "no app data was found before the update; the readback proves nothing",
    ],
  );
  assert.deepEqual(
    inPlaceUpdateFailures({
      apk,
      before,
      after: { ...before, versionCode: 5 },
      installedSha256: apk.sha256,
      domainsBefore: null,
    }),
    [],
  );
});
