/** Exercises android sms gateway template behavior with deterministic app-core test fixtures. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appCoreRoot, "../..");
const manifestPath = path.join(
  appCoreRoot,
  "platforms",
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);
const installScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "install-android-sms-gateway.mjs",
);
const watchScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "watch-sms-gateway-readiness.mjs",
);
const readinessScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "check-sms-gateway-readiness.mjs",
);
const installRunbookPath = path.join(
  appCoreRoot,
  "scripts",
  "install-android-sms-gateway.md",
);
const homepageReadinessScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "check-homepage-public-readiness.mjs",
);
const homepagePorkbunDnsScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "sync-homepage-porkbun-dns.mjs",
);
const completionAuditScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "check-sms-gateway-completion-audit.mjs",
);
const validateBlueBubblesScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "validate-bluebubbles-outbound.mjs",
);
const verifyBlueBubblesInboundScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "verify-bluebubbles-inbound-readiness.mjs",
);
const mobileBuildScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "run-mobile-build.mjs",
);
const verifyBlueBubblesScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "verify-bluebubbles-gateway-e2e.mjs",
);
const verifyAndroidScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "verify-android-sms-gateway-e2e.mjs",
);
const verifyCloudOnboardingScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "verify-cloud-sms-onboarding-flow.mjs",
);
const verifyCloudProdScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "verify-cloud-api-production-deploy.mjs",
);
const deployCloudProdScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "deploy-cloud-api-production-gateway.mjs",
);
const continueGatewayScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "continue-sms-gateway-work.mjs",
);
const maintainCloudProdScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "maintain-cloud-api-production-gateway.mjs",
);
const smsGatewayStatusScriptPath = path.join(
  appCoreRoot,
  "scripts",
  "sms-gateway-status.mjs",
);
const homepageReadmePath = path.join(
  repoRoot,
  "packages",
  "homepage",
  "README.md",
);
const packageJsonPath = path.join(appCoreRoot, "package.json");

test("Android template keeps the default SMS gateway surface", () => {
  const manifest = fs.readFileSync(manifestPath, "utf8");

  for (const marker of [
    "android.permission.READ_SMS",
    "android.permission.SEND_SMS",
    "android.permission.RECEIVE_SMS",
    "android.permission.RECEIVE_MMS",
    "android.permission.RECEIVE_WAP_PUSH",
    "android.hardware.telephony",
    ".ElizaSmsReceiver",
    ".ElizaMmsReceiver",
    ".ElizaSmsGatewayService",
    ".ElizaRespondViaMessageService",
    ".ElizaSmsComposeActivity",
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
    "android.permission.BROADCAST_SMS",
    "android.permission.BROADCAST_WAP_PUSH",
    "android.permission.SEND_RESPOND_VIA_MESSAGE",
  ]) {
    assert.match(manifest, new RegExp(escapeRegExp(marker)));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Android gateway installer supports one-command wireless pairing", () => {
  const script = fs.readFileSync(installScriptPath, "utf8");
  const watchScript = fs.readFileSync(watchScriptPath, "utf8");
  const readinessScript = fs.readFileSync(readinessScriptPath, "utf8");
  const installRunbook = fs.readFileSync(installRunbookPath, "utf8");
  const homepageReadinessScript = fs.readFileSync(
    homepageReadinessScriptPath,
    "utf8",
  );
  const homepagePorkbunDnsScript = fs.readFileSync(
    homepagePorkbunDnsScriptPath,
    "utf8",
  );
  const completionAuditScript = fs.readFileSync(
    completionAuditScriptPath,
    "utf8",
  );
  const verifyBlueBubblesInboundScript = fs.readFileSync(
    verifyBlueBubblesInboundScriptPath,
    "utf8",
  );
  const verifyAndroidScript = fs.readFileSync(verifyAndroidScriptPath, "utf8");
  const verifyCloudOnboardingScript = fs.readFileSync(
    verifyCloudOnboardingScriptPath,
    "utf8",
  );
  const verifyCloudProdScript = fs.readFileSync(
    verifyCloudProdScriptPath,
    "utf8",
  );
  const deployCloudProdScript = fs.readFileSync(
    deployCloudProdScriptPath,
    "utf8",
  );
  const continueGatewayScript = fs.readFileSync(
    continueGatewayScriptPath,
    "utf8",
  );
  const maintainCloudProdScript = fs.readFileSync(
    maintainCloudProdScriptPath,
    "utf8",
  );
  const smsGatewayStatusScript = fs.readFileSync(
    smsGatewayStatusScriptPath,
    "utf8",
  );
  const mobileBuildScript = fs.readFileSync(mobileBuildScriptPath, "utf8");
  const homepageReadme = fs.readFileSync(homepageReadmePath, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  for (const marker of [
    "--pair <endpoint>",
    "--pair-code <code>",
    "--wait-pair <seconds>",
    "--connect <endpoint>",
    "Defaults to preserved .eliza-local artifact, then generated APK",
    "firstExisting([preservedApk, generatedApk])",
    "Enter Wireless debugging pairing code",
    "Timed out waiting",
    "adb pair",
    "adb connect",
    "_adb-tls-pairing",
    "_adb-tls-connect",
    "none look like an Android phone",
    "sms-gateway:build:android",
    "BlueBubbles Shortcut is installed but needs a real validation send",
    "After explicit real-send approval",
    "sms-gateway:validate:bluebubbles -- --confirm-real-send",
  ]) {
    assert.match(script, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "mdns",
    "_adb-tls-pairing",
    "wireless pairing ready",
    "Run Android pair/connect/install/watch flow when actionable",
    'runInstallFlow(["--pair", pairing.endpoint, "--connect", "auto"], "60")',
    "tryConnectWirelessAdb",
    "connect-probe",
    "wireless adb connected",
    "printedBlueBubblesValidationHint",
    "BlueBubbles Shortcut is installed but needs a real validation send",
    "sms-gateway:validate:bluebubbles -- --confirm-real-send",
    "--pair",
    "--connect auto",
    "Pixel|Samsung",
  ]) {
    assert.match(watchScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "printGateSection",
    "\\bBLOCKED\\b",
    '"status"\\s*:\\s*"blocked"',
    "none look like an Android phone",
    "routingContractTests",
    "coverage = false",
    "sms-gateway-routing-",
    "phone-gateway-devices.test.ts",
    "agent-gateway-router.test.ts",
    "message-router",
    "index.test.ts",
  ]) {
    assert.match(readinessScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "preserved audited artifact",
    ".eliza-local/artifacts/eliza-android-sms-gateway-debug.apk",
    "then falls back to `packages/app/android/.../app-debug.apk`",
    "check-sms-gateway-completion-audit.mjs",
    "separates proven software/cloud requirements from external gates",
  ]) {
    assert.match(installRunbook, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "GitHub Pages DNS records",
    "sms-gateway:homepage:dns -- --apply",
    "expectedApexRecords",
    "expectedWwwCname",
    "A ${expectedDomain}",
    "CNAME www.${expectedDomain}",
    "homepage-public-readiness-latest.json",
    "--evidence <path>",
    "writeEvidence",
    "registryStatuses",
    "delegatedNameservers",
  ]) {
    assert.match(homepageReadinessScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Guarded Porkbun DNS helper",
    "dry-run only. Pass --apply",
    "dry-run only. No DNS changes were attempted",
    "no Porkbun credentials found",
    "PORKBUN_API_KEY",
    "PORKBUN_SECRET_API_KEY",
    "PORKBUN_API_BASE",
    "--api-base <url>",
    "/dns/retrieve/${args.domain}",
    "/dns/delete/${args.domain}/${item.id}",
    "/dns/create/${args.domain}",
    "Refusing to manage",
    "expectedApexRecords",
    "expectedWwwCname",
  ]) {
    assert.match(homepagePorkbunDnsScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Public `eliza.app` DNS",
    "client hold",
    "A eliza.app",
    "185.199.108.153",
    "CNAME www.eliza.app",
    "elizaos.github.io.",
    "check-homepage-public-readiness.mjs",
    "sms-gateway:homepage:dns",
    "PORKBUN_API_KEY",
  ]) {
    assert.match(homepageReadme, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "adbMdnsServices",
    "Advertised wireless ADB services",
    "No wireless ADB pairing/connect services are currently advertised",
    "Open Android Developer Options > Wireless debugging > Pair device with pairing code",
    "--pair auto --wait-pair 300 --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60",
    "android-sms-gateway-e2e-latest.json",
    "--evidence <path>",
    "writeEvidence",
    "writeNoDeviceEvidence",
    "pairingEndpointAdvertised",
    "connectEndpointAdvertised",
    "no_adb_device",
    "nextSteps:",
    "milestones:",
    "logTail:",
  ]) {
    assert.match(verifyAndroidScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "allow-gateway-override",
    "Refusing to verify non-shared gateway",
    "assertGatewayIdentity",
    "gatewayDevicePhoneNumber",
    "gatewayDeviceBridgeId",
    "gatewayDeviceProvider",
    "gatewayDeviceRegistered !== true",
    "device=${first.gatewayDevicePhoneNumber}/${first.gatewayDeviceBridgeId}/${first.gatewayDeviceProvider}",
    "gateway=${args.gatewayPhone}",
    "registered=yes",
  ]) {
    assert.match(verifyCloudOnboardingScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Production Cloud API smoke",
    "wrangler",
    "versions",
    "verify-cloud-sms-onboarding-flow.mjs",
    "[cloud-api-prod] PASS",
    "gateway=\\+14159611510",
    "device=\\+14159611510\\/bluebubbles\\/blooio",
  ]) {
    assert.match(verifyCloudProdScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Build, deploy, and verify the production Cloud API gateway contract",
    "packages",
    "cloud-api",
    "bun",
    "run",
    "build",
    "deploy",
    "verify-cloud-api-production-deploy.mjs",
    "PASS production Cloud API gateway contract deployed and verified",
  ]) {
    assert.match(deployCloudProdScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Safe continuation cycle",
    "maintain-cloud-api-production-gateway.mjs",
    "test-sms-gateway-software.mjs",
    "--apply-dns",
    "sync-homepage-porkbun-dns.mjs",
    "check-homepage-public-readiness.mjs",
    "validate-bluebubbles-outbound.mjs",
    "watch-sms-gateway-readiness.mjs",
    "sms-gateway-status.mjs",
    "--watch-seconds",
    "--run-install",
    "without sending a real SMS/iMessage",
  ]) {
    assert.match(continueGatewayScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Verify production Cloud API gateway contract, repairing only on drift",
    "verify-cloud-api-production-deploy.mjs",
    "deploy-cloud-api-production-gateway.mjs",
    "drift detected; running production repair deploy",
    "PASS no repair needed",
    "PASS repaired production gateway contract",
  ]) {
    assert.match(maintainCloudProdScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Concise operator status",
    "check-sms-gateway-completion-audit.mjs",
    "status=blocked",
    "homepage-public-dns",
    "routing-contracts",
    "build:linked-workspaces",
    "android-transport",
    "bluebubbles-transport",
    "explicit real-send approval",
    "sms-gateway:homepage:dns -- --apply",
    "sms-gateway:watch:pair",
    "sms-gateway:verify:bluebubbles",
    "sms-gateway-completion-audit-latest.json",
    "auditEvidencePath",
    "readAuditEvidence",
    "findRequirement",
    "supplementalSummary",
    "evidence homepage-public-dns",
    "evidence android-transport",
    "evidence bluebubbles-validation",
    "evidence bluebubbles-egress",
    "sms-gateway-blockers-latest.json",
    "buildBlockerBundle",
    "writeBlockerBundle",
    "[sms-gateway-status] blockers=",
    "[sms-gateway-status] evidence=",
  ]) {
    assert.match(smsGatewayStatusScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "homepage-bundle",
    "published homepage bundle points users at the shared gateway number",
    "homepage-public-dns",
    "public eliza.app domain resolves to the published homepage",
    "gateway=\\+14159611510 registered=yes",
    "device=\\+14159611510\\/bluebubbles\\/blooio",
    "production Cloud API routes unknown sender to onboarding through +14159611510/bluebubbles/blooio",
    "verify-cloud-api-production-deploy.mjs",
    "\\[cloud-api-prod\\] PASS",
    "sms-gateway:deploy:cloud-prod",
    "phone-gateway-devices\\.test\\.ts",
    "agent-gateway-router\\.test\\.ts",
    "16 pass",
    "message-router\\/index\\.test\\.ts",
    "sms-gateway-routing-audit-",
    "build:linked-workspaces",
    "provisioning-handoff",
    "createBunTestCwd",
    "coverage = false",
    "sms-gateway-provisioning-",
    "onboarding-chat.test.ts",
    "provisioning.test.ts",
    "post-login provisioning grants starter credit",
    "android-apk",
    "eliza-android-sms-gateway-debug\\.apk",
    "SMS gateway manifest surface is present",
    "bluebubbles-inbound",
    "BlueBubbles fallback bridge can receive and forward inbound events to Cloud as +14159611510",
    "verify-bluebubbles-inbound-readiness.mjs",
    "gateway=\\+14159611510",
    "verify-android-sms-gateway-e2e.mjs",
    "sms-gateway:validate:bluebubbles",
    "NEXT ${check.key}",
    "A eliza.app -> 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153",
    "CNAME www.eliza.app -> elizaos.github.io.",
    "sms-gateway:homepage:dns -- --apply",
    "sms-gateway:pair",
    "sms-gateway:watch:pair",
    "after explicit real-send approval",
    "sms-gateway-completion-audit-latest.json",
    "supplementalEvidenceByCheck",
    "bluebubbles-outbound-validation-latest.json",
    "bluebubbles-gateway-e2e-latest.json",
    "android-sms-gateway-e2e-latest.json",
    "readSupplementalEvidence",
    "summarizeEvidenceJson",
    "blockedChecks",
    "registryStatuses",
    "delegatedNameservers",
    "apexRecords",
    "wwwCnames",
    "--evidence <path>",
    "writeEvidence",
    "requirements:",
    "rawSummary",
    "status=blocked physical/end-to-end completion is not proven",
  ]) {
    assert.match(completionAuditScript, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "androidSmsGatewayDebugApkArtifact",
    "elizaRepoRoot",
    "eliza-android-sms-gateway-debug.apk",
    "preserveAndroidSmsGatewayArtifact",
    "android-sms-gateway preserved APK",
  ]) {
    assert.match(mobileBuildScript, new RegExp(escapeRegExp(marker)));
  }

  assert.equal(
    packageJson.scripts["sms-gateway:audit"],
    "node ./scripts/check-sms-gateway-completion-audit.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:pair"],
    "node ./scripts/install-android-sms-gateway.mjs --pair auto --wait-pair 300 --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:watch:pair"],
    "node ./scripts/watch-sms-gateway-readiness.mjs --timeout 300 --interval 5 --run-install",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:build:android"],
    "node ./scripts/run-mobile-build.mjs android-sms-gateway",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:continue"],
    "node ./scripts/continue-sms-gateway-work.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:deploy:cloud-prod"],
    "node ./scripts/deploy-cloud-api-production-gateway.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:homepage:dns"],
    "node ./scripts/sync-homepage-porkbun-dns.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:maintain:cloud-prod"],
    "node ./scripts/maintain-cloud-api-production-gateway.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:status"],
    "node ./scripts/sms-gateway-status.mjs",
  );
  assert.equal(
    packageJson.scripts["sms-gateway:verify:cloud-prod"],
    "node ./scripts/verify-cloud-api-production-deploy.mjs",
  );

  for (const marker of [
    'expectedGatewayPhoneNumber = "+14159611510"',
    "/doctor",
    "/diagnostics",
    "inbound-webhook",
    "gateway=${gatewayPhone}",
    "does not send SMS",
  ]) {
    assert.match(
      verifyBlueBubblesInboundScript,
      new RegExp(escapeRegExp(marker)),
    );
  }
});

test("BlueBubbles outbound validation command is guarded before real sends", () => {
  const script = fs.readFileSync(validateBlueBubblesScriptPath, "utf8");
  const verifyScript = fs.readFileSync(verifyBlueBubblesScriptPath, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  for (const marker of [
    "--confirm-real-send",
    "Refusing to send without --confirm-real-send",
    "Refusing to validate while bridge prerequisites are blocked",
    "/outbound/validate",
    "/diagnostics",
    "bluebubbles-outbound-validation-latest.json",
    "--evidence <path>",
    "writeEvidence",
    "needs_confirm_real_send",
    "bridge_prerequisites_blocked",
    "shortcut target=",
    "shortcutsRunTarget",
    "shortcutsInputContract",
    "latest preserved Shortcut input=",
    "This command transmits a real SMS/iMessage",
    "+14153024399",
  ]) {
    assert.match(script, new RegExp(escapeRegExp(marker)));
  }

  for (const marker of [
    "Shortcut outbound validation missing",
    "sms-gateway:validate:bluebubbles -- --confirm-real-send",
    "bluebubbles-gateway-e2e-latest.json",
    "--evidence <path>",
    "writeEvidence",
    "pendingBefore",
    "pendingAfter",
    "sentCount",
  ]) {
    assert.match(verifyScript, new RegExp(escapeRegExp(marker)));
  }

  assert.equal(
    packageJson.scripts["sms-gateway:validate:bluebubbles"],
    "node ./scripts/validate-bluebubbles-outbound.mjs",
  );
});

test("Porkbun DNS helper dry-runs without mutating records", async () => {
  const porkbun = await startMockPorkbunDns();
  try {
    const result = await runNode([
      homepagePorkbunDnsScriptPath,
      "--api-base",
      porkbun.url,
      "--api-key",
      "test-key",
      "--secret-api-key",
      "test-secret",
    ]);

    assert.equal(result.code, 0, result.output);
    assert.equal(porkbun.retrieveRequests, 1);
    assert.equal(porkbun.deleteRequests.length, 0);
    assert.equal(porkbun.createRequests.length, 0);
    assert.equal(porkbun.records.length, 5);
  } finally {
    await porkbun.close();
  }
});

test("Porkbun DNS helper applies only the GitHub Pages records for eliza.app", async () => {
  const porkbun = await startMockPorkbunDns();
  try {
    const result = await runNode([
      homepagePorkbunDnsScriptPath,
      "--api-base",
      porkbun.url,
      "--api-key",
      "test-key",
      "--secret-api-key",
      "test-secret",
      "--apply",
    ]);

    assert.equal(result.code, 0, result.output);
    assert.equal(porkbun.retrieveRequests, 2);
    assert.deepEqual(
      porkbun.deleteRequests.map((request) => request.id).sort(),
      ["2", "3", "4"],
    );
    assert.deepEqual(
      porkbun.createRequests.map((request) => ({
        type: request.body.type,
        name: request.body.name,
        content: request.body.content,
        ttl: request.body.ttl,
      })),
      [
        { type: "A", name: "", content: "185.199.109.153", ttl: "600" },
        { type: "A", name: "", content: "185.199.110.153", ttl: "600" },
        { type: "A", name: "", content: "185.199.111.153", ttl: "600" },
        {
          type: "CNAME",
          name: "www",
          content: "elizaos.github.io.",
          ttl: "600",
        },
      ],
    );
    assert.deepEqual(
      porkbun.records
        .filter((record) => record.type === "A" && record.name === "eliza.app")
        .map((record) => record.content)
        .sort(),
      [
        "185.199.108.153",
        "185.199.109.153",
        "185.199.110.153",
        "185.199.111.153",
      ],
    );
    assert.equal(
      porkbun.records.find(
        (record) => record.type === "CNAME" && record.name === "www.eliza.app",
      )?.content,
      "elizaos.github.io.",
    );
  } finally {
    await porkbun.close();
  }
});

test("BlueBubbles validation command refuses to POST without real-send confirmation", async () => {
  const bridge = await startMockBlueBubblesBridge();
  const evidencePath = temporaryEvidencePath(
    "bluebubbles-validation-no-confirm-",
  );
  try {
    const result = await runNode([
      validateBlueBubblesScriptPath,
      "--bridge-url",
      bridge.url,
      "--recipient",
      "+15555550123",
      "--message",
      "guard test",
      "--evidence",
      evidencePath,
    ]);

    assert.notEqual(result.code, 0);
    assert.equal(bridge.doctorRequests, 1);
    assert.equal(bridge.diagnosticsRequests, 1);
    assert.equal(bridge.validateRequests.length, 0);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.ok, false);
    assert.equal(evidence.blocker, "needs_confirm_real_send");
    assert.equal(evidence.recipient, "+15555550123");
  } finally {
    await bridge.close();
  }
});

test("BlueBubbles e2e verifier stops before retrying when validation is missing", async () => {
  const bridge = await startMockBlueBubblesBridge();
  try {
    const result = await runNode([
      verifyBlueBubblesScriptPath,
      "--bridge-url",
      bridge.url,
    ]);

    assert.notEqual(result.code, 0);
    assert.equal(bridge.doctorRequests, 1);
    assert.equal(bridge.pendingRequests, 0);
    assert.equal(bridge.retryRequests, 0);
  } finally {
    await bridge.close();
  }
});

test("BlueBubbles validation command POSTs only after real-send confirmation", async () => {
  const bridge = await startMockBlueBubblesBridge();
  const evidencePath = temporaryEvidencePath(
    "bluebubbles-validation-confirmed-",
  );
  try {
    const result = await runNode([
      validateBlueBubblesScriptPath,
      "--bridge-url",
      bridge.url,
      "--recipient",
      "+15555550123",
      "--message",
      "confirmed guard test",
      "--method",
      "shortcuts",
      "--evidence",
      evidencePath,
      "--confirm-real-send",
    ]);

    assert.equal(result.code, 0, result.output);
    assert.equal(bridge.doctorRequests, 1);
    assert.equal(bridge.diagnosticsRequests, 1);
    assert.equal(bridge.validateRequests.length, 1);
    assert.deepEqual(bridge.validateRequests[0], {
      recipient: "+15555550123",
      message: "confirmed guard test",
      method: "shortcuts",
    });
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.blocker, null);
    assert.equal(evidence.recipient, "+15555550123");
  } finally {
    await bridge.close();
  }
});

test("BlueBubbles validation command refuses confirmed sends when bridge prerequisites are blocked", async () => {
  const evidencePath = temporaryEvidencePath(
    "bluebubbles-validation-prereq-blocked-",
  );
  const bridge = await startMockBlueBubblesBridge({
    checks: [
      { name: "bridge", status: "pass", detail: "local bridge status=ok" },
      {
        name: "bluebubbles-server",
        status: "blocked",
        detail: "server unreachable",
      },
      {
        name: "outbound",
        status: "blocked",
        detail:
          "Shortcut outbound validation missing: no successful validation send recorded",
      },
    ],
  });
  try {
    const result = await runNode([
      validateBlueBubblesScriptPath,
      "--bridge-url",
      bridge.url,
      "--recipient",
      "+15555550123",
      "--message",
      "blocked prerequisites test",
      "--evidence",
      evidencePath,
      "--confirm-real-send",
    ]);

    assert.notEqual(result.code, 0);
    assert.equal(bridge.doctorRequests, 1);
    assert.equal(bridge.diagnosticsRequests, 1);
    assert.equal(bridge.validateRequests.length, 0);
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.ok, false);
    assert.equal(evidence.blocker, "bridge_prerequisites_blocked");
    assert.equal(evidence.recipient, "+15555550123");
  } finally {
    await bridge.close();
  }
});

async function startMockBlueBubblesBridge(options = {}) {
  const state = {
    doctorRequests: 0,
    diagnosticsRequests: 0,
    pendingRequests: 0,
    retryRequests: 0,
    validateRequests: [],
  };

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/doctor") {
      state.doctorRequests += 1;
      writeJson(res, 200, {
        status: "blocked",
        checks: options.checks ?? [
          { name: "bridge", status: "pass", detail: "local bridge status=ok" },
          {
            name: "outbound",
            status: "blocked",
            detail:
              "Shortcut outbound validation missing: no successful validation send recorded",
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && req.url === "/diagnostics") {
      state.diagnosticsRequests += 1;
      writeJson(res, 200, {
        bridge: {
          shortcutsRunTarget: "785A8251-AC4B-4D3F-B0AA-C66188E6F2A3",
          shortcutsInputContract: {
            inputType: "json-file",
            requiredKeys: ["recipient", "message"],
            optionalKeys: [
              "chatGuid",
              "gatewayPhoneNumber",
              "gatewayPhoneLabel",
            ],
          },
          recentShortcutInputs: [
            {
              path: "/tmp/eliza-shortcut-validation.json",
            },
          ],
        },
      });
      return;
    }

    if (req.method === "GET" && req.url === "/pending-replies") {
      state.pendingRequests += 1;
      writeJson(res, 200, { count: 1, replies: [] });
      return;
    }

    if (
      req.method === "POST" &&
      req.url?.startsWith("/pending-replies/retry")
    ) {
      state.retryRequests += 1;
      writeJson(res, 200, { sent: [] });
      return;
    }

    if (req.method === "POST" && req.url === "/outbound/validate") {
      const body = JSON.parse(await readRequestBody(req));
      state.validateRequests.push(body);
      writeJson(res, 200, {
        ok: true,
        validation: {
          validatedAt: "2026-05-20T09:30:00.000Z",
          method: body.method ?? "shortcuts",
          recipient: body.recipient,
          messagePreview: body.message,
        },
      });
      return;
    }

    writeJson(res, 404, { error: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  return {
    get doctorRequests() {
      return state.doctorRequests;
    },
    get diagnosticsRequests() {
      return state.diagnosticsRequests;
    },
    get pendingRequests() {
      return state.pendingRequests;
    },
    get retryRequests() {
      return state.retryRequests;
    },
    get validateRequests() {
      return state.validateRequests;
    },
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function startMockPorkbunDns() {
  const state = {
    records: [
      {
        id: "1",
        type: "A",
        name: "eliza.app",
        content: "185.199.108.153",
      },
      {
        id: "2",
        type: "A",
        name: "eliza.app",
        content: "203.0.113.10",
      },
      {
        id: "3",
        type: "A",
        name: "eliza.app",
        content: "185.199.108.153",
      },
      {
        id: "4",
        type: "CNAME",
        name: "www.eliza.app",
        content: "example.com.",
      },
      {
        id: "5",
        type: "TXT",
        name: "eliza.app",
        content: "leave-me-alone",
      },
    ],
    nextId: 6,
    retrieveRequests: 0,
    deleteRequests: [],
    createRequests: [],
  };

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { status: "ERROR", message: "method not allowed" });
      return;
    }

    if (req.url === "/dns/retrieve/eliza.app") {
      state.retrieveRequests += 1;
      await readRequestBody(req);
      writeJson(res, 200, { status: "SUCCESS", records: state.records });
      return;
    }

    const deleteMatch = req.url?.match(/^\/dns\/delete\/eliza\.app\/([^/]+)$/);
    if (deleteMatch) {
      await readRequestBody(req);
      const id = deleteMatch[1];
      state.deleteRequests.push({ id });
      state.records = state.records.filter((record) => record.id !== id);
      writeJson(res, 200, { status: "SUCCESS" });
      return;
    }

    if (req.url === "/dns/create/eliza.app") {
      const body = JSON.parse(await readRequestBody(req));
      state.createRequests.push({ body });
      const name = body.name ? `${body.name}.eliza.app` : "eliza.app";
      state.records.push({
        id: String(state.nextId++),
        type: body.type,
        name,
        content: body.content,
        ttl: body.ttl,
      });
      writeJson(res, 200, { status: "SUCCESS" });
      return;
    }

    writeJson(res, 404, { status: "ERROR", message: "not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  return {
    get retrieveRequests() {
      return state.retrieveRequests;
    },
    get deleteRequests() {
      return state.deleteRequests;
    },
    get createRequests() {
      return state.createRequests;
    },
    get records() {
      return state.records;
    },
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function runNode(args) {
  return new Promise((resolve) => {
    execFile("node", args, { timeout: 5_000 }, (error, stdout, stderr) => {
      const errorText = error instanceof Error ? error.message : "";
      resolve({
        code:
          error && typeof error === "object" && "code" in error
            ? error.code
            : 0,
        output: `${stdout}${stderr}${errorText}`,
      });
    });
  });
}

function temporaryEvidencePath(prefix) {
  const tmpRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, prefix));
  return path.join(dir, "evidence.json");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}
