#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "../..");

const DANGEROUS_CHROMIUM_SANDBOX_FLAGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
];

const CHROMIUM_SANDBOX_SCAN_ROOTS = [
  "packages/app/src",
  "packages/app-core/src",
  "packages/app-core/platforms/electrobun/src",
  "packages/agent/src",
  "packages/ui/src",
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".ts",
  ".tsx",
  ".swift",
]);

const REQUIRED_ANDROID_HIGH_RISK_PERMISSIONS = [
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.CALL_PHONE",
  "android.permission.MANAGE_APP_OPS_MODES",
  "android.permission.MANAGE_OWN_CALLS",
  "android.permission.PACKAGE_USAGE_STATS",
  "android.permission.READ_CALL_LOG",
  "android.permission.READ_CONTACTS",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_SMS",
  "android.permission.RECEIVE_MMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.RECEIVE_WAP_PUSH",
  "android.permission.SEND_SMS",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.WRITE_CONTACTS",
];

const REQUIRED_ANDROID_HIGH_RISK_COMPONENT_MARKERS = [
  "android.intent.category.HOME",
  "android.permission.BIND_INCALL_SERVICE",
  "android.provider.Telephony.SMS_DELIVER",
  "android.provider.Telephony.WAP_PUSH_DELIVER",
  "android.intent.action.RESPOND_VIA_MESSAGE",
  "android.intent.category.APP_CONTACTS",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
];

const REQUIRED_IOS_PRIVACY_KEYS = [
  "NSPrivacyAccessedAPITypes",
  "NSPrivacyAccessedAPICategoryUserDefaults",
  "NSPrivacyCollectedDataTypes",
  "NSPrivacyTracking",
  "NSPrivacyTrackingDomains",
];

const REQUIRED_IOS_ENTITLEMENT_KEYS = [
  "aps-environment",
  "com.apple.developer.family-controls",
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
  "com.apple.security.application-groups",
];

const REQUIRED_MODE_LITERALS = ["remote-mac", "cloud", "cloud-hybrid", "local"];

const STORE_REVIEW_DOC =
  "packages/docs/docs/launchdocs/22-store-review-notes.md";

const REQUIRED_STORE_REVIEW_DOC_MARKERS = [
  "Permissions Kept For Full-Capability Review",
  "Core Feature Use",
  "local-safe",
  "local-yolo",
  "Mobile Limitations",
  "Android Store Notes",
  "iOS App Review Notes",
];

function rel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/") || ".";
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function addError(errors, error) {
  errors.push({
    severity: "error",
    ...error,
  });
}

function walkFiles(rootPath) {
  if (!exists(rootPath)) return [];
  const files = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const nextPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(nextPath));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(nextPath);
    }
  }
  return files;
}

function androidPermissions(manifest) {
  return new Set(
    [
      ...manifest.matchAll(
        /<uses-permission\b[^>]*android:name=["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]),
  );
}

function checkChromiumSandboxFlags(repoRoot, errors, checks) {
  const findings = [];
  for (const scanRoot of CHROMIUM_SANDBOX_SCAN_ROOTS) {
    for (const filePath of walkFiles(path.join(repoRoot, scanRoot))) {
      const content = readText(filePath);
      if (!content) continue;
      for (const flag of DANGEROUS_CHROMIUM_SANDBOX_FLAGS) {
        if (content.includes(flag)) {
          findings.push({ file: rel(repoRoot, filePath), flag });
        }
      }
    }
  }
  checks.push({
    id: "chromium-sandbox-flags",
    ok: findings.length === 0,
    scannedRoots: CHROMIUM_SANDBOX_SCAN_ROOTS,
    disallowedFlags: DANGEROUS_CHROMIUM_SANDBOX_FLAGS,
    findings,
  });
  if (findings.length > 0) {
    addError(errors, {
      type: "chromium-sandbox-disabled",
      findings,
      message:
        "store/runtime Chromium launch paths must not disable the Chromium sandbox",
    });
  }
}

function checkAndroidLocalAuth(repoRoot, errors, checks) {
  const servicePath =
    "packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java";
  const pluginPath =
    "packages/native-plugins/agent/android/src/main/java/ai/eliza/plugins/agent/AgentPlugin.kt";
  const serverAuthPaths = [
    "packages/app-core/src/api/compat-route-shared.ts",
    "packages/agent/src/api/server-helpers-auth.ts",
    "packages/agent/src/api/auth-routes.ts",
  ];
  const service = readText(path.join(repoRoot, servicePath)) ?? "";
  const plugin = readText(path.join(repoRoot, pluginPath)) ?? "";
  const serverAuth = serverAuthPaths
    .map((file) => readText(path.join(repoRoot, file)) ?? "")
    .join("\n");
  const missing = [];
  const require = (condition, label) => {
    if (!condition) missing.push(label);
  };

  require(service.includes(
    "generateLocalAgentToken()",
  ), "per-boot token generation");
  require(service.includes("writeLocalAgentTokenFile"), "token persistence");
  require(service.includes('"ELIZA_REQUIRE_LOCAL_AUTH"') &&
    service.includes('"1"') &&
    service.includes(
      '"ELIZA_API_TOKEN"',
    ), "agent env requires local auth and token");
  require(plugin.includes("Authorization") &&
    plugin.includes('"Bearer $token"'), "native plugin injects bearer token");
  require(plugin.includes(
    "${context.packageName}.ElizaAgentService",
  ), "native plugin resolves app service from runtime package name");
  require(serverAuth.includes(
    "ELIZA_REQUIRE_LOCAL_AUTH",
  ), "server-side local auth gate reads ELIZA_REQUIRE_LOCAL_AUTH");

  checks.push({
    id: "android-local-auth-env",
    ok: missing.length === 0,
    files: [servicePath, pluginPath, ...serverAuthPaths],
    missing,
  });
  if (missing.length > 0) {
    addError(errors, {
      type: "android-local-auth-env-incomplete",
      file: servicePath,
      missing,
      message: `Android local-agent auth behavior is incomplete: ${missing.join(", ")}`,
    });
  }
}

function checkAndroidHighRiskManifest(repoRoot, errors, checks) {
  const manifestPath = "packages/app/android/app/src/main/AndroidManifest.xml";
  const content = readText(path.join(repoRoot, manifestPath));
  if (!content) {
    checks.push({
      id: "android-high-risk-manifest",
      ok: false,
      file: manifestPath,
    });
    addError(errors, {
      type: "missing-file",
      file: manifestPath,
      message: "missing generated Android manifest for full-capability review",
    });
    return;
  }

  const permissions = androidPermissions(content);
  const missingPermissions = REQUIRED_ANDROID_HIGH_RISK_PERMISSIONS.filter(
    (permission) => !permissions.has(permission),
  );
  const missingComponentMarkers =
    REQUIRED_ANDROID_HIGH_RISK_COMPONENT_MARKERS.filter(
      (marker) => !content.includes(marker),
    );
  const ok =
    missingPermissions.length === 0 && missingComponentMarkers.length === 0;
  checks.push({
    id: "android-high-risk-manifest",
    ok,
    file: manifestPath,
    permissionCount: permissions.size,
    missingPermissions,
    missingComponentMarkers,
  });
  if (!ok) {
    addError(errors, {
      type: "android-high-risk-manifest-incomplete",
      file: manifestPath,
      missingPermissions,
      missingComponentMarkers,
      message:
        "generated Android manifest must keep full-capability high-risk permission and component declarations in sync with store review notes",
    });
  }
}

function checkIosPrivacyAndEntitlements(repoRoot, errors, checks) {
  const files = [
    {
      id: "ios-privacy:app-template",
      path: "packages/app-core/platforms/ios/App/App/PrivacyInfo.xcprivacy",
      required: REQUIRED_IOS_PRIVACY_KEYS,
    },
    {
      id: "ios-privacy:app-generated",
      path: "packages/app/ios/App/App/PrivacyInfo.xcprivacy",
      required: REQUIRED_IOS_PRIVACY_KEYS,
    },
    {
      id: "ios-entitlements:app-template-disclosures",
      path: "packages/app-core/platforms/ios/App/App/App.entitlements",
      required: REQUIRED_IOS_ENTITLEMENT_KEYS,
    },
    {
      id: "ios-entitlements:app-generated-disclosures",
      path: "packages/app/ios/App/App/App.entitlements",
      required: REQUIRED_IOS_ENTITLEMENT_KEYS,
    },
  ];

  for (const item of files) {
    const content = readText(path.join(repoRoot, item.path));
    const missing = content
      ? item.required.filter((marker) => !content.includes(marker))
      : item.required;
    const placeholderValues = content
      ? [...content.matchAll(/\$\([A-Z0-9_]+\)/g)].map((match) => match[0])
      : [];
    const ok = Boolean(content) && missing.length === 0;
    checks.push({
      id: item.id,
      ok,
      file: item.path,
      missing,
      placeholderValues,
    });
    if (!ok) {
      addError(errors, {
        type: "ios-disclosure-incomplete",
        file: item.path,
        missing,
        message: `iOS privacy/entitlement disclosure placeholders are incomplete: ${missing.join(", ")}`,
      });
    }
  }
}

function checkModeCoverage(repoRoot, errors, checks) {
  const files = [
    "packages/app/src/ios-runtime.ts",
    "packages/ui/src/platform/ios-runtime.ts",
    "packages/ui/src/onboarding/mobile-runtime-mode.ts",
    "packages/app/src/main.tsx",
  ];
  const contentByFile = Object.fromEntries(
    files.map((file) => [file, readText(path.join(repoRoot, file)) ?? ""]),
  );
  const missing = [];
  for (const mode of REQUIRED_MODE_LITERALS) {
    for (const file of files.slice(0, 3)) {
      if (!contentByFile[file].includes(`"${mode}"`)) {
        missing.push(`${file}:${mode}`);
      }
    }
  }
  if (
    !contentByFile["packages/app/src/main.tsx"].includes(
      'config.mode !== "cloud-hybrid" && config.mode !== "local"',
    )
  ) {
    missing.push("packages/app/src/main.tsx:device bridge mode gate");
  }

  checks.push({
    id: "mobile-mode-coverage",
    ok: missing.length === 0,
    files,
    requiredModes: REQUIRED_MODE_LITERALS,
    missing,
  });
  if (missing.length > 0) {
    addError(errors, {
      type: "mobile-mode-coverage-incomplete",
      missing,
      message: `mobile runtime mode coverage is incomplete: ${missing.join(", ")}`,
    });
  }
}

function checkStoreReviewDoc(repoRoot, errors, checks) {
  const content = readText(path.join(repoRoot, STORE_REVIEW_DOC));
  const missing = content
    ? REQUIRED_STORE_REVIEW_DOC_MARKERS.filter(
        (marker) => !content.includes(marker),
      )
    : REQUIRED_STORE_REVIEW_DOC_MARKERS;
  const ok = Boolean(content) && missing.length === 0;
  checks.push({
    id: "store-review-notes-doc",
    ok,
    file: STORE_REVIEW_DOC,
    missing,
  });
  if (!ok) {
    addError(errors, {
      type: "store-review-notes-doc-incomplete",
      file: STORE_REVIEW_DOC,
      missing,
      message: `store review launchdocs notes are incomplete: ${missing.join(", ")}`,
    });
  }
}

export function checkStoreSecurity(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const errors = [];
  const checks = [];

  checkChromiumSandboxFlags(repoRoot, errors, checks);
  checkAndroidLocalAuth(repoRoot, errors, checks);
  checkAndroidHighRiskManifest(repoRoot, errors, checks);
  checkIosPrivacyAndEntitlements(repoRoot, errors, checks);
  checkModeCoverage(repoRoot, errors, checks);
  checkStoreReviewDoc(repoRoot, errors, checks);

  return {
    ok: errors.length === 0,
    repoRoot,
    checkedAt: new Date().toISOString(),
    summary: {
      checkCount: checks.length,
      errorCount: errors.length,
    },
    checks,
    errors,
  };
}

function printHuman(result) {
  if (result.ok) {
    console.log(
      `[store-security-gate] PASS ${result.summary.checkCount} static check(s)`,
    );
    return;
  }

  console.error(
    `[store-security-gate] FAIL ${result.summary.errorCount} issue(s) across ${result.summary.checkCount} static check(s)`,
  );
  for (const error of result.errors) {
    console.error(`- ${error.file ?? "repo"} ${error.message}`);
  }
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    repoRoot:
      argv
        .find((arg) => arg.startsWith("--repo-root="))
        ?.slice("--repo-root=".length) ??
      process.env.STORE_SECURITY_GATE_REPO_ROOT,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkStoreSecurity({
    repoRoot: args.repoRoot,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(result.ok ? 0 : 1);
}
