// Native Eliza Cloud sign-in client (packages/auth/android). The pure policy and the exact plugin
// methods run on a plain JVM with synthetic ports; the Android wiring is checked from source. This
// builds no APK, runs nothing on Android, and contacts neither Eliza Cloud nor Google.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const main = join(root, "src/main/java/ai/eliza/auth/cloud");
const tests = join(root, "test/ai/eliza/auth/cloud");
const read = (file) => readFileSync(file, "utf8");
const plugin = read(join(main, "CloudSignInPlugin.java"));
const binary = (name) =>
  process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
const between = (text, start, end) => {
  const from = text.indexOf(start),
    to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} … ${end} located`);
  return text.slice(from, to);
};
/** Pure sources: everything except the Android plugin and the Credential Manager wrapper. */
const pure = readdirSync(main)
  .filter(
    (name) =>
      name.endsWith(".java") &&
      !["CloudSignInPlugin.java", "NativeGoogleCredential.java"].includes(name),
  )
  .map((name) => join(main, name));
const support = [
  join(root, "test/org/json/JSONObject.java"),
  join(tests, "TestRegistration.java"),
];

function runJvm(sources, mainClass, args = []) {
  const output = mkdtempSync(join(tmpdir(), "eliza-cloud-sign-in-"));
  try {
    execFileSync(
      binary("javac"),
      ["--release", "17", "-d", output, ...sources],
      {
        timeout: 120000,
      },
    );
    return execFileSync(binary("java"), ["-cp", output, mainClass, ...args], {
      encoding: "utf8",
      timeout: 120000,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
/** Injects exact plugin methods into a harness, dropping `private` so the harness can call them. */
function harness(template, methods) {
  let source = read(join(tests, template));
  for (const [name, body] of Object.entries(methods)) {
    assert.ok(body, name);
    source = source.replace(
      `/* ${name} */`,
      body.replace(/^ private (static )?/gm, " $1"),
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "eliza-cloud-sign-in-src-"));
  const file = join(directory, template.replace(/\.txt$/, ""));
  writeFileSync(file, source);
  return { file, directory };
}

test("registration, PKCE, callback, pending record, failures, routes, readiness and code adapters (plain JVM)", () => {
  assert.match(
    runJvm(
      [...pure, ...support, join(tests, "CloudSignInFlowTest.java")],
      "ai.eliza.auth.cloud.CloudSignInFlowTest",
    ),
    /^PASS cloud sign-in flow \(\d+ checks\)/,
  );
});

test("bounded saved-key revocation for a confirmed reset (plain JVM)", () => {
  assert.match(
    runJvm(
      [...pure, ...support, join(tests, "CloudKeyRevocationResetTest.java")],
      "ai.eliza.auth.cloud.CloudKeyRevocationResetTest",
    ),
    /^PASS cloud reset revocation \(\d+ checks\)/,
  );
});

test("callback contract vectors through the native parser", () => {
  const contract = JSON.parse(
    read(join(root, "test/fixtures/app-auth-callback-contract.json")),
  );
  for (const kind of ["success", "error", "return", "reject"])
    assert.ok(
      contract.cases.some((row) => row.expect === kind),
      `vectors cover ${kind}`,
    );
  // A code is a success only from the fragment; no other vector carries one as a result.
  for (const row of contract.cases)
    if (row.expect === "success")
      assert.ok(
        new URL(row.url).hash.includes("code=") && !new URL(row.url).search,
        row.name,
      );
  const flow = read(join(main, "CloudSignInFlow.java"));
  for (const error of contract.errorAllowlist)
    assert.ok(flow.includes(`"${error}"`), `native allowlists ${error}`);
  assert.equal(
    new Set(flow.match(/"(?:app_link_unverified|mfa_required|oauth_[a-z_]+)"/g))
      .size,
    contract.errorAllowlist.length,
    "no error outside the allowlist",
  );
  const lines = [
    ...contract.cases.map((row) => [
      row.environment,
      row.expect,
      row.url,
      row.code ?? "",
      row.state ?? "",
      row.error ?? "",
    ]),
    ...contract.fallbackHandoffs.map((row) => [
      row.environment,
      row.expect,
      row.deliveredUrl,
      "",
      "",
      "",
    ]),
  ];
  for (const line of lines)
    assert.ok(line.every((field) => !/[\t\n]/.test(field)));
  const directory = mkdtempSync(join(tmpdir(), "eliza-cloud-contract-"));
  try {
    const vectors = join(directory, "vectors.tsv");
    writeFileSync(
      vectors,
      `${lines.map((line) => line.join("\t")).join("\n")}\n`,
    );
    assert.match(
      runJvm(
        [...pure, ...support, join(tests, "CloudSignInContractTest.java")],
        "ai.eliza.auth.cloud.CloudSignInContractTest",
        [
          vectors,
          contract.callbackPath,
          contract.hosts.production,
          contract.hosts.staging,
        ],
      ),
      new RegExp(`^PASS callback contract \\(${lines.length} vectors\\)`),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native Google responses map to a fixed classification and a bounded diagnostic", () => {
  assert.match(
    runJvm(
      [...pure, ...support, join(tests, "NativeGoogleClassificationTest.java")],
      "ai.eliza.auth.cloud.NativeGoogleClassificationTest",
    ),
    /^PASS native Google classification/,
  );
});

test("exact native verify/connect/token/ack chain keeps failures explicit and custody native (plain JVM)", () => {
  const { file, directory } = harness("CloudSignInChainTest.java.txt", {
    ACTUAL_CREDENTIAL_IDENTITY: between(
      plugin,
      " @PluginMethod public void credentialIdentity(",
      " /**\n  * Called once when an explicit attempt",
    ).replace("@PluginMethod ", ""),
    ACTUAL_CALLER_REQUEST: between(
      plugin,
      " private static String callerRequestId(",
      " @PluginMethod public void startGoogle(",
    ),
    ACTUAL_CANCEL: between(
      plugin,
      " @PluginMethod public void cancel(",
      " /** Post-authentication consent",
    ).replace("@PluginMethod ", ""),
    ACTUAL_CALLBACK: between(
      plugin,
      " private boolean captureCallback(",
      " /** Retire only the captured record",
    ),
    ACTUAL_BURN: between(
      plugin,
      " private void burnUnclaimedPending(Attempt owner)",
      " // ── Email code and MFA:",
    ),
    // startEmail, startPhone and notSent: one contiguous region.
    ACTUAL_START_EMAIL: between(
      plugin,
      " @PluginMethod public void startEmail(",
      " /** Check registration and tenant SMS policy",
    ).replaceAll("@PluginMethod ", ""),
    ACTUAL_VERIFY:
      between(
        plugin,
        " private void verify(PluginCall call, boolean mfa)",
        " private void release(",
      ) +
      between(
        plugin,
        " private void completeOrRequireMfa(",
        " // ── Shared tail:",
      ),
    ACTUAL_RELEASE: between(
      plugin,
      " private void release(",
      " /** A retained MFA event",
    ),
    ACTUAL_COMPLETE: between(
      plugin,
      " private void complete(",
      " /** The saved key",
    ),
    ACTUAL_PREVIOUS_TOKEN: between(
      plugin,
      " private static String previousToken(",
      " /** Bounded retry",
    ),
    ACTUAL_ACK: between(
      plugin,
      " private CloudSignInFlow.Ack acknowledge(",
      " /**\n  * A key stored before an interrupted ack",
    ),
    ACTUAL_ACK_RECOVERY: between(
      plugin,
      " /**\n  * A key stored before an interrupted ack",
      " // ── Silent key renewal",
    ),
    ACTUAL_RENEWAL: between(
      plugin,
      " /** One renewal check of a deployment's saved key.",
      " // ── Outcomes and transport",
    ).replace("@PluginMethod ", ""),
    ACTUAL_OUTCOMES: between(
      plugin,
      " private void finish(",
      " /** Cloud refusing",
    ),
    ACTUAL_INSTANT: between(
      plugin,
      " private static long instant(",
      " private Response post(",
    ),
  });
  try {
    const output = runJvm(
      [...pure, ...support, file],
      "ai.eliza.auth.cloud.CloudSignInChainTest",
    );
    assert.match(
      output,
      /^PASS native code verification ownership \(4 scenarios\)$/m,
    );
    assert.match(
      output,
      /^PASS native sign-in chain \(39 scenarios; no browser facilities\)/m,
    );
    assert.match(
      output,
      /^PASS native startup acknowledgement recovery \(26 scenarios\)$/m,
    );
    assert.match(
      output,
      /^PASS transient verification answers keep the code step \(5 scenarios\)$/m,
    );
    assert.match(
      output,
      /^PASS SMS sends honour Cloud's cooldown for SMS only \(8 scenarios\)$/m,
    );
    assert.match(
      output,
      /^PASS in-process acknowledgement retry and expiry \(10 scenarios\)$/m,
    );
    assert.match(
      output,
      /^PASS browser return in a new process \(8 scenarios\)$/m,
    );
    assert.match(output, /^PASS silent key renewal \(20 scenario groups\)$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact readiness measurement, cache and single-flight probe (plain JVM)", () => {
  const { file, directory } = harness("CloudSignInReadinessTest.java.txt", {
    ACTUAL_MEASURE: between(
      plugin,
      " private CloudSignInReadiness.Result measure(",
      " // ── Google: native",
    ),
    ACTUAL_STATUS: between(
      plugin,
      " @PluginMethod public void status(",
      " private JSObject statusOutcome(",
    ),
    ACTUAL_STATUS_OUTCOME: between(
      plugin,
      " private JSObject statusOutcome(",
      " /**\n  * A fresh cached answer is served at once",
    ),
    ACTUAL_PROBE: between(
      plugin,
      " private void probe(",
      " /** Cloud refused this app",
    ),
    // The exact pause and resume handlers, without the Capacitor superclass calls.
    ACTUAL_RESUME: between(
      plugin,
      " @Override protected void handleOnPause() {",
      " @Override protected void handleOnDestroy() {",
    )
      .replaceAll("@Override protected ", "")
      .replace("super.handleOnPause();", "")
      .replace("super.handleOnResume();", ""),
  });
  try {
    const output = runJvm(
      [...pure, ...support, file],
      "ai.eliza.auth.cloud.CloudSignInReadinessTest",
    );
    assert.match(output, /^PASS native readiness measure/);
    assert.match(
      output,
      /^PASS per-method readiness TTL, resume and return link watch$/m,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the plugin owns every secret, compares state before burning and logs only fixed Google diagnostics", () => {
  assert.match(
    plugin,
    /^public abstract class CloudSignInPlugin extends Plugin \{/m,
  );
  assert.doesNotMatch(
    plugin,
    /@CapacitorPlugin/,
    "the host subclass declares its plugin name",
  );
  for (const product of [/Alpha/, /alphacompute/, /BuildConfig/])
    assert.doesNotMatch(
      plugin,
      product,
      "no product identity or build flag in the shared client",
    );
  const diagnostic = between(
    plugin,
    " private void logGoogleOutcome(",
    "\n /**\n  * Strict App Link capture",
  );
  assert.equal(
    diagnostic
      .slice(diagnostic.indexOf("{") + 1, diagnostic.lastIndexOf("}"))
      .trim(),
    "android.util.Log.i(config().logTag, CloudSignInFlow.googleDiagnostic(stage, status, outcome, current.startedAt, current.expiresAt, System.currentTimeMillis()));",
    "the only log accepts the fixed serializer, never raw response, URL, token, headers or body",
  );
  assert.equal(
    (plugin.match(/android\.util\.Log\./g) || []).length,
    1,
    "one native log sink",
  );
  assert.doesNotMatch(
    plugin.replace(diagnostic, ""),
    /android\.util\.Log|System\.out|printStackTrace|Log\.[dewiv]\(/,
  );
  // The tenant is encoded in both provider reads.
  assert.equal(
    (
      plugin.match(
        /\/steward\/auth\/providers\?tenantId=" \+ Uri\.encode\(environment\.tenant\)/g,
      ) || []
    ).length,
    2,
  );
  // Results carry no secret.
  for (const resolved of plugin.match(/\.resolve\([^;]*;/g) || [])
    assert.doesNotMatch(
      resolved,
      /token|secret|verifier|refresh|code"/i,
      resolved,
    );
  // Fixed routes only, no redirects, origin and route checked before any connection.
  const post = between(
    plugin,
    "private Response post(Attempt current, CloudSignInEnvironment environment,",
    "/** The readiness probe",
  );
  assert.ok(
    post.indexOf("CloudSignInRoutes.origin(") < post.indexOf("fetch(") &&
      post.indexOf("CloudSignInRoutes.route(") < post.indexOf("fetch("),
  );
  assert.match(
    between(
      plugin,
      "private Fetched fetch(URI url, byte[] body, String bearer, Attempt current",
      "private static final class Fetched",
    ),
    /setInstanceFollowRedirects\(false\)/,
  );
  // Native Google: platform picker with a server nonce and the registered Steward app client.
  const google = between(
    plugin,
    "@PluginMethod public void startGoogle(",
    "/**\n  * Strict App Link capture",
  );
  assert.match(google, /NativeGoogleCredential\.request/);
  assert.equal(
    (google.match(/\.put\("clientId", config\(\)\.googleClientId\)/g) || [])
      .length,
    2,
  );
  // Browser returns: consumed once, state compared before burning, burned before any request.
  const capture = between(
    plugin,
    "private boolean captureCallback(",
    "private void burnUnclaimedPending(Attempt owner)",
  );
  assert.ok(
    capture.indexOf("intent.setData(null)") > 0 &&
      capture.indexOf("intent.setData(null)") < capture.indexOf("run(() ->"),
  );
  const noResult = between(
    capture,
    "ReturnKind.RETURN) {",
    "// Not this device",
  );
  assert.doesNotMatch(noResult, /\.remove\(|burnUnclaimedPending/);
  assert.ok(
    capture.indexOf("!pending.sameState(received)) return;") <
      capture.indexOf(
        "compareExchange(config().pendingSlot, pendingRaw, null)",
      ),
  );
  assert.ok(
    capture.indexOf("compareExchange(config().pendingSlot, pendingRaw, null)") <
      capture.indexOf('"/steward/auth/oauth/exchange"'),
  );
  // Tail: Android authorization before connect; receipt, key, ack; the Steward session is revoked.
  const tail = between(
    plugin,
    "private void complete(Attempt current, JSONObject session)",
    "/** The saved key for this environment",
  );
  assert.ok(
    tail.indexOf("requireAuthorization(current);") >
      tail.indexOf("validStewardToken(token)") &&
      tail.indexOf("requireAuthorization(current);") <
        tail.indexOf('"/api/v1/app-auth/connect"'),
  );
  const key = tail.indexOf(
      "credentials.write(config().credentialSlot(environment)",
    ),
    ack = tail.indexOf("acknowledge(current, proof");
  assert.ok(
    tail.indexOf("receipts.write(config().receiptSlot(environment)") < key &&
      key < ack,
    "receipt, then key, then ack",
  );
  assert.ok(
    tail.indexOf("current.credentialGuard.run()") < key,
    "the accepted attempt's existing host fence guards the key write",
  );
  assert.ok(
    tail.indexOf("previousToken(") < key &&
      tail.indexOf("CloudKeyRevocation.revoke(") > ack,
  );
  assert.match(tail, /finally[\s\S]*"\/steward\/auth\/logout"/);
  assert.doesNotMatch(
    tail,
    /\.write\([^)]*(refresh|token\b)/,
    "the Steward session is never stored",
  );
  assert.match(
    plugin,
    /for \(int round = 0; round < CloudSignInFlow\.ACK_ATTEMPTS; round\+\+\)/,
  );
  assert.match(
    plugin,
    /@Override public void load\(\) \{[\s\S]*?run\(this::resumeAcknowledgements\);/,
  );
  // Email: one adapter, a per-attempt verify cap and a global send cooldown; one sign-in at a time.
  const email = between(
    plugin,
    "@PluginMethod public void startEmail(",
    "@PluginMethod public void startPhone(",
  );
  assert.match(
    email,
    /long allowedAt = Math\.max\(lastEmailSendAt \+ CloudSignInFlow\.RESEND_COOLDOWN_MS, emailSendAllowedAt\);\s*if \(now < allowedAt\) \{ call\.reject\("Wait before requesting another code", "cooldown", sendWait\(allowedAt\)\); return; \}/,
  );
  assert.ok(
    plugin.indexOf(
      "emailSendAllowedAt = Math.max(emailSendAllowedAt, resendAt)",
    ) <
      plugin.indexOf(
        'if (sent.status != 200 && sent.status != 202) throw new SignInFailure(CloudSignInFlow.failureForStatus("send"',
      ),
  );
  // Cloud's longer wait belongs to the method that was asked: only the local minimum is shared.
  const phone = between(
    plugin,
    "@PluginMethod public void startPhone(",
    "/** A failed send leaves the code already sent",
  );
  assert.match(
    phone,
    /long allowedAt = Math\.max\(lastEmailSendAt \+ CloudSignInFlow\.RESEND_COOLDOWN_MS, smsSendAllowedAt\);\s*if \(now < allowedAt\) \{ call\.reject\("Wait before requesting another code", "cooldown", sendWait\(allowedAt\)\); return; \}/,
  );
  assert.match(
    phone,
    /lastEmailSendAt = now; smsSendAllowedAt = Math\.max\(smsSendAllowedAt, resendAt\);/,
  );
  assert.doesNotMatch(phone, /emailSendAllowedAt/);
  assert.doesNotMatch(email, /smsSendAllowedAt/);
  // The only datum a send rejection carries is when the next send may be tried.
  assert.match(
    plugin,
    /private static JSObject sendWait\(long resendAt\) \{ return new JSObject\(\)\.put\("resendAt", resendAt\); \}/,
  );
  assert.doesNotMatch(
    plugin,
    /"\/steward\/auth\/email\/send"/,
    "no magic-link send",
  );
  assert.match(
    google,
    /if \(attempt != null\) \{ call\.reject\("Another sign-in is in progress", "login-active"\); return; \}/,
  );
  const gate = between(
    plugin,
    "private void requireAuthorization(Attempt current)",
    "private void completeOrRequireMfa(",
  );
  assert.match(gate, /new AlertDialog\.Builder/);
  assert.match(gate, /"Authorize " \+ product/);
  assert.doesNotMatch(gate, /PluginCall|call\.getBoolean|\.write\(/);
});

test("a browser Google attempt on a Home host ends only by its return, a cancel or its expiry; in a host's own task a closed page ends it", () => {
  // Pause and resume can end an attempt only through `browserPaused`, which is set only for a page
  // that was opened in the host's own task (any host that is not the Home app).
  const pause = between(
    plugin,
    " @Override protected void handleOnPause() {",
    " /**\n  * A browser Google page in the host's own task",
  );
  assert.match(
    pause,
    /if \(attempt != null && attempt\.browserLaunched && attempt\.browserInHostTask\) attempt\.browserPaused = true;/,
  );
  assert.equal(
    (plugin.match(/browserPaused = true/g) || []).length,
    1,
    "one place marks a page as covering the host",
  );
  assert.equal(
    (plugin.match(/browserInHostTask = /g) || []).length,
    1,
    "one place decides whose task holds the page",
  );
  const resume = between(
    plugin,
    " @Override protected void handleOnResume() {",
    " @Override protected void handleOnDestroy() {",
  );
  assert.match(
    resume,
    /if \(current == null \|\| !current\.browserPaused\) return;\s*main\.postDelayed\(\(\) -> \{\s*synchronized \(lock\) \{\s*if \(attempt != current \|\| current\.cancelled \|\| current\.callbackReceived \|\| current\.returnHint \|\| current\.returnClaimed\) return;\s*end\(current, "browser-closed", true\);\s*\}\s*\}, BROWSER_RETURN_GRACE_MS\);/,
  );
  assert.equal((resume.match(/end\(/g) || []).length, 1);
  // Readiness on resume is passive and bounded: only for a recent sign-in screen or an attempt.
  assert.match(
    resume,
    /measure = CloudSignInReadiness\.resumeProbe\(System\.currentTimeMillis\(\), statusAskedAt, current != null\);/,
  );
  assert.match(
    resume,
    /if \(measure\) probe\(config\(\)\.defaultEnvironment\(\), null, false, true\);/,
  );
  assert.equal(
    (plugin.match(/"browser-closed"/g) || []).length,
    2,
    "a closed page is reported by the resume grace and by a return that could not be consumed",
  );
  const start = between(
    plugin,
    " private void startGoogleBrowser(Attempt next) {",
    " /** The attempt's own deadline",
  );
  // The only timer of the attempt is its pending record's own lifetime, and it yields to a return.
  assert.match(
    start,
    /expireBrowserAttempt\(next, CloudSignInFlow\.PENDING_TTL_MS\);/,
  );
  assert.doesNotMatch(start, /postDelayed/);
  const expiry = between(
    plugin,
    " private void expireBrowserAttempt(Attempt next, long delay) {",
    " /** The host is this device's Home app",
  );
  assert.match(
    expiry,
    /if \(attempt != next \|\| next\.cancelled \|\| next\.callbackReceived\) return;\s*if \(next\.returnClaimed\) \{ expireBrowserAttempt\(next, BROWSER_RETURN_GRACE_MS\); return; \}\s*\}\s*end\(next, "expired", true\);/,
  );
  assert.match(
    start,
    /final boolean home = hostIsHome\(\);\s*synchronized \(lock\) \{\s*if \(attempt != next \|\| next\.cancelled \|\| destroyed\) return;\s*next\.browserLaunched = true; next\.browserInHostTask = !home;\s*\}/,
  );
  assert.match(
    start,
    /final int task = home \? Intent\.FLAG_ACTIVITY_NEW_TASK : 0;/,
  );
  assert.equal((start.match(/\.addFlags\(task\)/g) || []).length, 2);
  const home = between(
    plugin,
    " private boolean hostIsHome() {",
    " /** Optional caller identity",
  );
  assert.match(
    home,
    /Intent\.ACTION_MAIN\)\.addCategory\(Intent\.CATEGORY_HOME\)/,
  );
  assert.match(
    home,
    /getContext\(\)\.getPackageName\(\)\.equals\(home\.activityInfo\.packageName\)/,
  );
  // A return that cannot be consumed leaves the attempt. Only an elapsed parameterless hint ends it,
  // or, for a page in the host's own task, having come back to the host without one.
  const release = between(
    plugin,
    " private void releaseReturnClaim(Attempt claimed) {",
    " /** Retire only the captured record",
  );
  assert.equal((release.match(/end\(/g) || []).length, 2);
  assert.match(
    release,
    /if \(claimed\.returnHintElapsed\) end\(claimed, "app-link-unverified", false\);\s*else if \(claimed\.browserPaused && !claimed\.returnHint\) end\(claimed, "browser-closed", true\);/,
  );
  // A return in a process that did not start the sign-in completes only by adopting the credential
  // intent that wrote its record (the host's durable generation); it never reserves a new one, and
  // without that it still completes nothing.
  const capture = between(
    plugin,
    " private boolean captureCallback(",
    " /** A recognized but unconsumable return",
  );
  assert.match(
    capture,
    /owner = adoptReturn\(pending, pendingRaw, now\);\s*if \(owner == null\) \{\s*notifyListeners\("signInIncomplete", new JSObject\(\)\.put\("code", "app-link-unverified"\), true\);\s*return;\s*\}\s*\}\s*if \(!pending\.state\.equals\(owner\.browserState\)\) return;/,
  );
  const adopt = between(capture, " private Attempt adoptReturn(", "\n }\n");
  assert.ok(
    adopt.indexOf(
      "if (pending.generation == null || pending.expired(now)) return null;",
    ) > 0 &&
      adopt.indexOf(
        "if (pending.generation == null || pending.expired(now)) return null;",
      ) < adopt.indexOf("adoptCredentialCommit(pending.generation)"),
    "a record without a generation, or an expired one, never reaches the host",
  );
  assert.match(adopt, /if \(guard == null\) return null;/);
  assert.match(
    adopt,
    /if \(destroyed \|\| attempt != null \|\| pendingRetirementUnconfirmed\) return null;/,
  );
  assert.doesNotMatch(
    capture,
    /reserveCredentialCommit/,
    "a return never reserves a credential intent",
  );
  // Hosts opt in: every new host hook refuses by default.
  for (const hook of [
    "protected Runnable observeCredentialCommit() { return null; }",
    "protected String credentialGeneration() { return null; }",
    "protected Runnable adoptCredentialCommit(String generation) { return null; }",
  ])
    assert.ok(plugin.includes(hook), hook);
});

test("silent renewal confirms the new key before saving it, stores the duty to revoke the old key, revokes it last and reserves nothing", () => {
  const renewal = between(
    plugin,
    " // ── Silent key renewal",
    " // ── Outcomes and transport",
  );
  assert.doesNotMatch(
    renewal,
    /reserveCredentialCommit|requireAuthorization|\.write\(config\(\)\.receiptSlot/,
    "background renewal reserves no intent, shows no dialog and writes no receipt",
  );
  // The only slot a renewal ever removes is its own stored duty to revoke a replaced key.
  const removals =
    renewal.match(/(owned|slots|store\(\))\.remove\([^)]*\)/g) || [];
  assert.deepEqual(removals, [
    "slots.remove(retiring)",
    "slots.remove(retiring)",
  ]);
  const settled = renewal.slice(
    renewal.indexOf(" private JSObject renewalSettled("),
    renewal.indexOf(" private boolean retireReplaced("),
  );
  const refusal = settled.indexOf(
      "if (acknowledged != CloudSignInFlow.Ack.ACKNOWLEDGED) {",
    ),
    duty = settled.indexOf("owned.write(retiring, "),
    save = settled.indexOf("owned.write(slot, "),
    readmit = settled.indexOf("savedKeyRenewed(environment, installed)"),
    revokeOld = settled.indexOf(
      "retireReplaced(environment, previous, credentialId)",
    ),
    told = settled.indexOf('notifyListeners("signInRenewed"');
  assert.ok(
    refusal > 0 &&
      refusal < duty &&
      duty < save &&
      save < readmit &&
      readmit < revokeOld &&
      revokeOld < told,
    "unconfirmed: nothing saved; confirmed: duty stored, key saved, host re-admitted, old key revoked, renderer told",
  );
  assert.equal(
    (renewal.match(/\(environment, previous, credentialId[,)]/g) || []).length,
    2,
    "the working key is revoked in exactly one place (and its in-process retry), always naming the new key",
  );
  assert.equal((renewal.match(/\.write\(/g) || []).length, 2);
  // To Cloud a key that revokes itself without naming a confirmed successor is signing out, which
  // ends every key of the sign-in. A renewal sends that request in one place only: for a new key it
  // did not save, after the saved key was found to be no longer the one it presented.
  const selfRevocations = renewal.match(/CloudKeyRevocation\.revoke\(/g) || [];
  const abandon = between(
    renewal,
    " private void abandonSuccessor(",
    " /**\n  * Makes sure a key a renewal replaced",
  );
  assert.equal(
    (
      abandon.match(
        /CloudKeyRevocation\.revoke\(config\(\), environment, secret\)/g,
      ) || []
    ).length,
    selfRevocations.length,
    "a renewal revokes an unsaved key nowhere else",
  );
  assert.ok(
    abandon.indexOf(
      "if (previous.equals(token) || secret.equals(token)) return;",
    ) > 0 &&
      abandon.indexOf(
        "if (previous.equals(token) || secret.equals(token)) return;",
      ) < abandon.indexOf("CloudKeyRevocation.revoke("),
    "never while the key it was renewed from is still the saved one",
  );
  // The saved key is recorded as possibly superseded before the first confirmation request.
  const check = renewal.slice(
    renewal.indexOf(" private JSObject renewNow("),
    renewal.indexOf(" private void renewalAcknowledgement("),
  );
  assert.ok(
    check.indexOf("CloudKeyRenewal.Record.CONFIRMING") > 0 &&
      check.indexOf("CloudKeyRenewal.Record.CONFIRMING") <
        check.indexOf("acknowledge(null, proof, credentialId, secret)"),
  );
  // A replaced key counts as retired when Cloud revoked it or already refuses it (401), and the
  // request names the key it was renewed into.
  const retire = between(
    renewal,
    " private boolean retireReplaced(",
    " /** Two more tries in this process",
  );
  assert.match(
    retire,
    /if \(!CloudKeyRevocation\.retire\(config\(\), environment, replaced, successor\)\) return false;/,
  );
  const revocation = read(join(main, "CloudKeyRevocation.java"));
  assert.match(
    revocation,
    /public static final String RENEWED_CREDENTIAL_HEADER = "X-Renewed-Credential-Id";/,
  );
  assert.match(
    revocation,
    /if \(renewedInto != null\) connection\.setRequestProperty\(RENEWED_CREDENTIAL_HEADER, renewedInto\);/,
  );
  assert.match(
    revocation,
    /return successor != null && retired\(request\(config, environment, token, successor\)\);/,
    "a retirement never sends a request that names no successor",
  );
  // The stored duty never revokes the key that is still the saved one.
  const stored = renewal.slice(renewal.indexOf(" private void retireStored("));
  assert.ok(
    stored.indexOf("if (stillSaved || successor == null || ") > 0 &&
      stored.indexOf("if (stillSaved || successor == null || ") <
        stored.indexOf("retireReplaced(environment, replaced, successor)"),
  );
  // While Cloud's confirmation of the new key is still awaited, no expiry warning is reported.
  assert.match(
    renewal,
    /renewalAnswered\(environment, current, renewalOutcome\(environment, "deferred", expiresAt, false\), false\);/,
  );
  assert.match(
    plugin,
    /protected void savedKeyRenewed\(CloudSignInEnvironment environment, String credentialId\) throws Exception \{\}/,
  );
  // The request presents the saved key as a bearer token and an API key; no other request does.
  assert.match(
    renewal,
    /post\(null, environment, CloudKeyRenewal\.PATH, CloudKeyRenewal\.body\(config\(\), environment, state, CloudSignInFlow\.s256\(verifier\)\), previous\)/,
  );
  assert.match(
    plugin,
    /if \(bearer != null && bearer\.startsWith\("eliza_mobile_"\)\) connection\.setRequestProperty\("X-API-Key", bearer\);/,
  );
  // Automatic check on load and resume.
  assert.match(
    plugin,
    /@Override public void load\(\) \{[\s\S]*?renewSaved\(\);\n \}/,
  );
  assert.match(
    between(
      plugin,
      " @Override protected void handleOnResume() {",
      " @Override protected void handleOnDestroy() {",
    ),
    /renewSaved\(\);/,
  );
  assert.equal(
    read(join(main, "CloudKeyRenewal.java")).match(
      /public static final String PATH = "([^"]+)"/,
    )[1],
    "/api/v1/app-auth/mobile/renew",
  );
});

/** org.json as Android ships it, for the fixtures that run plugin-native-agent's real admission code. */
function jsonJar() {
  const cache = join(
    homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
  );
  const jar =
    process.env.ELIZA_JSON_JAR ||
    (existsSync(cache)
      ? readdirSync(cache).flatMap((directory) =>
          readdirSync(join(cache, directory))
            .filter((file) => file === "json-20250517.jar")
            .map((file) => join(cache, directory, file)),
        )[0]
      : undefined);
  assert.ok(
    jar,
    "Set ELIZA_JSON_JAR to org.json:json:20250517, or resolve that Gradle dependency",
  );
  return jar;
}

test("the exact renewal save through the resident credential store: the agent is stopped and re-admitted by the host hook before the old key is revoked (plain JVM)", () => {
  const { file, directory } = harness("CloudKeyRenewalResidentTest.java.txt", {
    ACTUAL_RENEWAL_SETTLED: between(
      plugin,
      " private JSObject renewalSettled(",
      " /**\n  * Stored duties to revoke a key a renewal replaced",
    ),
  });
  const workspace = resolve(root, "../../..");
  const agent = join(
    workspace,
    "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime",
  );
  const storage = join(
    workspace,
    "plugins/plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly",
  );
  const output = mkdtempSync(join(tmpdir(), "eliza-cloud-renewal-resident-"));
  try {
    const jar = jsonJar();
    execFileSync(
      binary("javac"),
      [
        "--release",
        "17",
        "-cp",
        jar,
        "-d",
        output,
        ...pure,
        join(tests, "TestRegistration.java"),
        join(agent, "ResidentCredentialStore.java"),
        join(agent, "NativeProviderAdmission.java"),
        join(storage, "CredentialMutationConductor.java"),
        file,
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        binary("java"),
        [
          "-cp",
          `${output}${delimiter}${jar}`,
          "ai.eliza.auth.cloud.CloudKeyRenewalResidentTest",
        ],
        { encoding: "utf8", timeout: 120000 },
      ),
      /^PASS renewal save through the resident credential store \(5 scenarios\)/,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the credential intent fence keeps a durable generation for work an earlier process began (plain JVM)", () => {
  const workspace = resolve(root, "../../..");
  assert.match(
    runJvm(
      [
        join(
          workspace,
          "plugins/plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly/CredentialIntentFence.java",
        ),
        join(
          workspace,
          "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/CredentialIntentFence.java",
        ),
        join(root, "test/ai/eliza/auth/cloud/CredentialGenerationTest.java"),
      ],
      "ai.eliza.auth.cloud.CredentialGenerationTest",
    ),
    /^PASS durable credential generation \(\d+ checks\)/,
  );
});

test("the exact Google observer logs only the fixed classification, never provider text (plain JVM)", () => {
  const methods = between(
    plugin,
    " private CloudSignInFlow.GoogleFailure observeGoogleResponse",
    " /**\n  * Strict App Link capture",
  );
  assert.ok(methods.includes('response.data.opt("error")'));
  const directory = mkdtempSync(join(tmpdir(), "eliza-cloud-google-observer-"));
  const file = join(directory, "NativeGoogleObserverTest.java");
  writeFileSync(
    file,
    `package ai.eliza.auth.cloud;
public class NativeGoogleObserverTest {
 static class Attempt {long startedAt=System.currentTimeMillis()-100;long expiresAt=System.currentTimeMillis()+10000;}
 static class Data {Object ok,error;Object opt(String k){return k.equals("ok")?ok:error;}}
 static class Response {int status;Data data=new Data();}
 static class Log {static String value;static int i(String tag,String line){value=tag+" "+line;return 0;}}
 CloudSignInConfig config(){return TestRegistration.PRODUCT;}
 ${methods.replaceAll("android.util.Log.i", "Log.i").replace(/^ private /gm, " ")}
 public static void main(String[]args){NativeGoogleObserverTest p=new NativeGoogleObserverTest();Response r=new Response();r.status=401;r.data.ok=false;r.data.error="Google identity could not be verified";
  CloudSignInFlow.GoogleFailure f=p.observeGoogleResponse(new Attempt(),CloudSignInFlow.GoogleStage.VERIFY,r);
  if(!"provider-refused".equals(f.code)||!Log.value.startsWith("ElizaCloudSignIn ")||!Log.value.contains("reason=google-identity-unverified")||Log.value.contains((String)r.data.error))throw new AssertionError(Log.value);
  r.data.error="SECRET_TOKEN\\nhttps://private/?jwt=secret";p.observeGoogleResponse(new Attempt(),CloudSignInFlow.GoogleStage.VERIFY,r);
  if(Log.value.contains("SECRET")||Log.value.contains("https")||!Log.value.contains("unclassified-provider-refusal"))throw new AssertionError(Log.value);
  System.out.println("PASS exact native Google observer");
 }
}`,
  );
  try {
    assert.match(
      runJvm(
        [...pure, ...support, file],
        "ai.eliza.auth.cloud.NativeGoogleObserverTest",
      ),
      /^PASS exact native Google observer/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the Gradle library declares what its plugin compiles against", () => {
  const gradle = read(join(root, "build.gradle"));
  assert.match(gradle, /namespace 'ai\.eliza\.auth\.cloud'/);
  assert.match(gradle, /implementation project\(':capacitor-android'\)/);
  // Plugin.getActivity() returns an AppCompatActivity, and Capacitor does not export AppCompat.
  assert.match(gradle, /implementation "androidx\.appcompat:appcompat:/);
  for (const dependency of [
    "androidx.credentials:credentials:",
    "androidx.credentials:credentials-play-services-auth:",
    "com.google.android.libraries.identity.googleid:googleid:",
  ])
    assert.ok(gradle.includes(dependency), dependency);
  assert.doesNotMatch(
    read(join(root, "src/main/AndroidManifest.xml")),
    /<(activity|service|receiver|provider|uses-permission|intent-filter)\b/,
    "the library declares no component, permission or link; hosts do",
  );
});

// ── Eliza's Android host (packages/app/platforms/android, ai.elizaos.app) ─────────────────────
// Eliza's app hosts this client as ElizaCloudSignInPlugin. Its registration and storage policy are
// pure and run here on a plain JVM with synthetic stores; the Android wiring is read from source.
const elizaAndroid = resolve(root, "../../app/platforms/android");
const elizaJava = join(elizaAndroid, "app/src/main/java/ai/elizaos/app");
const elizaHost = read(join(elizaJava, "ElizaCloudSignInPlugin.java"));

test("Eliza's host registration and storage policy (plain JVM)", () => {
  const directory = mkdtempSync(join(tmpdir(), "eliza-host-contract-"));
  const file = join(directory, "ElizaHostContractTest.java");
  writeFileSync(
    file,
    `package ai.elizaos.app;
import ai.eliza.auth.cloud.*;
import java.util.*;
import org.json.JSONObject;
public class ElizaHostContractTest {
 static int checks;
 static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); checks++; }
 static void refused(Runnable action, String what) { try { action.run(); } catch (RuntimeException expected) { checks++; return; } throw new AssertionError(what); }
 interface Unsafe { void run() throws Exception; }
 static Runnable unsafe(Unsafe action) { return () -> { try { action.run(); } catch (RuntimeException e) { throw e; } catch (Exception e) { throw new IllegalStateException(e); } }; }
 static final class Tokens implements ElizaCloudCredentialSlots.TokenStore {
  String value; int writes, removals;
  public String read() { return value; }
  public void write(String token) { value = token; writes++; }
  public void remove() { value = null; removals++; }
 }
 static final class Slots implements ElizaCloudCredentialSlots.NativeSlots {
  final Map<String, String> values = new HashMap<>();
  public String read(String slot) { return values.get(slot); }
  public void write(String slot, String value) { values.put(slot, value); }
  public void remove(String slot) { values.remove(slot); }
 }
 static String credential(String token, String serverId) {
  return new JSONObject().put("credentialId", UUID.randomUUID().toString()).put("token", token).put("expiresAt", 4102444800000L).put("serverCredentialId", serverId).toString();
 }
 public static void main(String[] args) throws Exception {
  CloudSignInConfig product = ElizaCloudSignInRegistration.registration(false);
  CloudSignInConfig development = ElizaCloudSignInRegistration.registration(true);
  // Registration: Cloud's first-party mobile client and its registered return, both deployments.
  check(product.clientId.equals("ai.elizaos.app"), "client id");
  check(product.productName.equals("Eliza") && product.deviceName.equals("Android"), "names");
  check(product.googleClientId.equals("eliza-app"), "Steward app client");
  check(product.environments().size() == 1 && product.defaultEnvironment().name.equals("production"), "a product build admits production only");
  refused(() -> product.environment("staging"), "staging refused by a product build");
  check(development.environments().size() == 2 && development.defaultEnvironment().name.equals("production"), "development adds staging after production");
  CloudSignInEnvironment production = development.environment("production"), staging = development.environment("staging");
  check(production.api().equals("https://cloud.eliza.app") && staging.api().equals("https://cloud-staging.eliza.app"), "API hosts");
  check(production.callback().equals("https://eliza.app/auth/callback") && staging.callback().equals("https://eliza.app/auth/callback"), "registered return");
  check(production.tenant.equals("elizacloud") && staging.tenant.equals("elizacloud-staging"), "Steward tenants");
  check(production.serviceName.equals("Eliza Cloud"), "service name");
  check(CloudSignInRoutes.origin(development, "https", "cloud.eliza.app", -1) && CloudSignInRoutes.origin(development, "https", "cloud-staging.eliza.app", 443), "admitted origins");
  check(!CloudSignInRoutes.origin(product, "https", "cloud-staging.eliza.app", -1) && !CloudSignInRoutes.origin(development, "https", "api.example.test", -1), "no other origin");
  // Installed names are compatibility identifiers.
  check(product.readinessPreferences.equals("eliza-cloud-signin-readiness") && product.pendingSlot.equals("cloud-signin:v1:pending"), "installed names");
  check(product.credentialSlot(production).equals("cloud:production") && product.receiptSlot(production).equals("cloud-signin:v1:ack:production"), "slot names");

  // Storage: the key is the renderer's session token; an owner record says which deployment minted it.
  int[] guards = {0};
  Tokens tokens = new Tokens(); Slots slots = new Slots();
  ElizaCloudCredentialSlots store = new ElizaCloudCredentialSlots(development, () -> guards[0]++, tokens, slots);
  check(store.read("cloud:production") == null && store.read("cloud:staging") == null, "nothing saved");
  // A session saved before this host (no owner record) is kept and never claimed by a deployment.
  tokens.value = "eliza_mobile_legacy";
  check(store.read("cloud:production") == null && store.read("cloud:staging") == null, "a legacy session is not attributed");
  store.write("cloud:production", credential("eliza_mobile_one", "11111111-1111-4111-8111-111111111111"));
  check("eliza_mobile_one".equals(tokens.value), "the key is the renderer's session token");
  String owner = slots.values.get(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT);
  check(owner != null, "owner record written");
  JSONObject ownerRecord = new JSONObject(owner);
  check(ownerRecord.opt("token") == null && ElizaCloudCredentialSlots.sha256("eliza_mobile_one").equals(ownerRecord.optString("tokenSha256", null)), "the owner record holds a digest, never the key");
  JSONObject saved = new JSONObject(store.read("cloud:production"));
  check("eliza_mobile_one".equals(saved.getString("token")) && "11111111-1111-4111-8111-111111111111".equals(saved.getString("serverCredentialId")) && saved.getLong("expiresAt") == 4102444800000L, "the saved credential reads back for its deployment");
  check(store.read("cloud:staging") == null, "another deployment never sees it");
  check(guards[0] == 2, "guard before each underlying write");
  // The renderer replaced the session (another sign-in or sign-out): no deployment claims it.
  tokens.value = "eliza_mobile_renderer";
  check(store.read("cloud:production") == null, "a replaced session is not presented, revoked or resumed");
  store.remove("cloud:production");
  check("eliza_mobile_renderer".equals(tokens.value) && !slots.values.containsKey(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT), "removal keeps a session it did not mint");
  // Staging takes the slot over; production no longer reads it.
  store.write("cloud:staging", credential("eliza_mobile_two", "22222222-2222-4222-8222-222222222222"));
  check(store.read("cloud:production") == null && store.read("cloud:staging") != null, "owner follows the last sign-in");
  store.remove("cloud:production");
  check("eliza_mobile_two".equals(tokens.value), "another deployment's removal changes nothing");
  store.remove("cloud:staging");
  check(tokens.value == null && tokens.removals == 1 && store.read("cloud:staging") == null, "the owning deployment removes its key");
  // Receipts and the pending record stay native-only and pass through unchanged.
  store.write("cloud-signin:v1:ack:production", "receipt");
  store.write("cloud-signin:v1:pending", "pending");
  check("receipt".equals(store.read("cloud-signin:v1:ack:production")) && "pending".equals(slots.values.get("cloud-signin:v1:pending")), "native slots");
  // A key a renewal replaced waits for its revocation in its own native-only slot.
  store.write("cloud-signin:v1:retire:production", "retiring");
  check("retiring".equals(store.read("cloud-signin:v1:retire:production")) && "retiring".equals(slots.values.get("cloud-signin:v1:retire:production")), "the retiring slot is a native slot");
  store.remove("cloud-signin:v1:retire:production");
  check(store.read("cloud-signin:v1:retire:production") == null, "retiring removed");
  refused(unsafe(() -> new ElizaCloudCredentialSlots(product, () -> {}, tokens, slots).read("cloud-signin:v1:retire:staging")), "a product build has no staging retiring slot");
  check(tokens.writes == 2, "native slots never touch the session token");
  store.remove("cloud-signin:v1:pending");
  check(store.read("cloud-signin:v1:pending") == null, "pending removed");
  refused(unsafe(() -> store.write("cloud:other", credential("x", "y"))), "unknown deployment slot");
  refused(unsafe(() -> store.read("session.steward_token")), "no arbitrary slot");
  refused(unsafe(() -> new ElizaCloudCredentialSlots(product, () -> {}, tokens, slots).write("cloud:staging", credential("x", "y"))), "a product build has no staging slot");
  // A closed or superseded sign-in commits nothing.
  ElizaCloudCredentialSlots closed = new ElizaCloudCredentialSlots(development, () -> { throw new IllegalStateException("Sign-in closed"); }, tokens, slots);
  refused(unsafe(() -> closed.write("cloud:production", credential("eliza_mobile_late", "33333333-3333-4333-8333-333333333333"))), "guard refuses");
  check(tokens.value == null && !slots.values.containsKey(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT), "nothing written after a refusal");
  // A malformed owner record is treated as no owner.
  tokens.value = "eliza_mobile_one";
  slots.values.put(ElizaCloudSignInRegistration.TOKEN_OWNER_SLOT, new JSONObject().put("version", 2).put("environment", "production").put("tokenSha256", ElizaCloudCredentialSlots.sha256("eliza_mobile_one")).toString());
  check(store.read("cloud:production") == null, "unknown owner version");
  System.out.println("PASS Eliza host contract (" + checks + " checks)");
 }
}`,
  );
  try {
    assert.match(
      runJvm(
        [
          ...pure,
          ...support,
          join(elizaJava, "ElizaCloudSignInRegistration.java"),
          join(elizaJava, "ElizaCloudCredentialSlots.java"),
          file,
        ],
        "ai.elizaos.app.ElizaHostContractTest",
      ),
      /^PASS Eliza host contract \(\d+ checks\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual Android resident credential mutation owns the exact stop and write (plain JVM)", () => {
  const source = read(join(elizaJava, "ElizaResidentCredentials.java"));
  const { file, directory } = harness(
    "ResidentCredentialMutationTest.java.txt",
    {
      ACTUAL_LIFECYCLE: between(
        source,
        "    private static final Object LIFECYCLE",
        "    private ElizaResidentCredentials()",
      ),
      ACTUAL_RESERVE: between(
        source,
        "    static Runnable reserve()",
        "    /** Read-only request fence",
      ),
      ACTUAL_HOST: between(
        source,
        "        CredentialMutationConductor.Host host()",
        "\n    }\n}",
      ),
    },
  );
  const workspace = resolve(root, "../../..");
  const storage = join(
    workspace,
    "plugins/plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly",
  );
  const lease = join(
    workspace,
    "plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/CredentialShutdownLease.java",
  );
  try {
    assert.match(
      runJvm(
        [
          ...[
            "CredentialIntentFence",
            "CredentialMutationConductor",
            "CredentialSlotMutation",
          ].map((name) => join(storage, `${name}.java`)),
          lease,
          file,
        ],
        "ai.elizaos.app.ResidentCredentialMutationTest",
      ),
      /^PASS Android resident credential mutation \(7 scenarios\)/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Eliza's Android app wires the host, its build and its renderer port", () => {
  // The host: its own Capacitor name, the shared client, Eliza's registration and storage.
  assert.match(
    elizaHost,
    /@CapacitorPlugin\(name = "ElizaCloudSignIn"\)\npublic final class ElizaCloudSignInPlugin extends CloudSignInPlugin \{/,
  );
  assert.match(
    elizaHost,
    /ElizaCloudSignInRegistration\.registration\(\s*BuildConfig\.DEBUG \|\| BuildConfig\.ELIZA_CLOUD_SIGN_IN_STAGING\)/,
    "staging only in development builds",
  );
  const credentialBinding = read(
    join(elizaJava, "ElizaResidentCredentials.java"),
  );
  assert.match(credentialBinding, /"session\.steward_token"/);
  assert.match(credentialBinding, /getNoBackupFilesDir\(\)/);
  assert.match(
    elizaHost,
    /reserveCredentialCommit\(\) \{ return ElizaResidentCredentials.reserve\(\); \}/,
  );
  assert.match(
    elizaHost,
    /return ElizaResidentCredentials.cloud\(getContext\(\), guard\);/,
  );
  assert.doesNotMatch(
    elizaHost,
    /@PluginMethod|android\.util\.Log/,
    "no extra sign-in flow or log beside the shared client",
  );
  const sources = [
    elizaHost,
    credentialBinding,
    read(join(elizaJava, "ElizaCloudSignInRegistration.java")),
    read(join(elizaJava, "ElizaCloudCredentialSlots.java")),
  ].join("\n");
  assert.doesNotMatch(
    sources,
    /eliza_mobile_[A-Za-z0-9]|AIza[0-9A-Za-z_-]{20}|apps\.googleusercontent\.com|BEGIN [A-Z ]*PRIVATE KEY/,
    "no credential value in source",
  );
  // Registered on the full build and on every Cloud build's generated activity.
  assert.match(
    read(join(elizaJava, "MainActivity.java")),
    /registerPlugin\(ElizaCloudSignInPlugin\.class\);/,
  );
  const cloudActivity = read(
    resolve(
      root,
      "../../app/scripts/mobile/android/templates/main-activity.ts",
    ),
  );
  assert.match(
    cloudActivity,
    /registerPlugin\(ElizaCloudSignInPlugin\.class\);/,
  );
  for (const source of [
    cloudActivity,
    read(join(elizaJava, "MainActivity.java")),
  ]) {
    assert.match(
      source,
      /initialPlugins\.add\(ElizaSecureStorePlugin\.class\);/,
      "resident-aware secure-store registration follows generated plugin discovery",
    );
  }
  assert.doesNotMatch(
    cloudActivity,
    /isCloudAuthCallback|loadUrl\(/,
    "no hosted sign-in navigation or callback reload",
  );
  // Gradle: this library is a module of Eliza's Android build, at a minimum SDK the app accepts.
  assert.match(
    read(join(elizaAndroid, "settings.gradle")),
    /include ':eliza-auth-cloud'\nproject\(':eliza-auth-cloud'\)\.projectDir = new File\(settingsDir, '\.\.\/\.\.\/\.\.\/auth\/android'\)/,
  );
  const appGradle = read(join(elizaAndroid, "app/build.gradle"));
  assert.match(appGradle, /implementation project\(':eliza-auth-cloud'\)/);
  assert.match(
    appGradle,
    /buildConfigField "boolean", "ELIZA_CLOUD_SIGN_IN_STAGING"/,
  );
  assert.match(
    read(join(elizaAndroid, "app/proguard-rules.pro")),
    /-keep class ai\.eliza\.auth\.cloud\.\*\* \{ \*; \}/,
  );
  const appMinSdk = Number(
    /minSdkVersion = (\d+)/.exec(
      read(join(elizaAndroid, "variables.gradle")),
    )[1],
  );
  const libraryMinSdk = Number(
    /minSdk (\d+)/.exec(read(join(root, "build.gradle")))[1],
  );
  assert.ok(
    libraryMinSdk <= appMinSdk,
    `library minSdk ${libraryMinSdk} <= app ${appMinSdk}`,
  );
  // Email, SMS and native Google open no browser: the app claims no https return link, so the
  // eliza.app callback page keeps opening in the browser for web sign-in.
  const manifest = read(join(elizaAndroid, "app/src/main/AndroidManifest.xml"));
  assert.doesNotMatch(manifest, /android:autoVerify="true"/);
  assert.doesNotMatch(manifest, /android:host="eliza\.app"/);
  // The renderer reaches the same Capacitor name through the shared port contract.
  const renderer = read(
    resolve(root, "../../ui/src/android-cloud/native-cloud-sign-in.ts"),
  );
  assert.match(
    renderer,
    /ELIZA_NATIVE_CLOUD_SIGN_IN_PLUGIN = "ElizaCloudSignIn"/,
  );
  assert.match(renderer, /from "@elizaos\/auth\/auth\/native-cloud-sign-in"/);
});
