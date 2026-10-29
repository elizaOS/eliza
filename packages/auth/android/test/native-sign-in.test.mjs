// Native Eliza Cloud sign-in client (packages/auth/android). The pure policy and the exact plugin
// methods run on a plain JVM with synthetic ports; the Android wiring is checked from source. This
// builds no APK, runs nothing on Android, and contacts neither Eliza Cloud nor Google.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
      " private boolean acknowledge(",
      " /** A key stored before",
    ),
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
    assert.match(
      runJvm(
        [...pure, ...support, file],
        "ai.eliza.auth.cloud.CloudSignInChainTest",
      ),
      /^PASS native sign-in chain \(14 scenarios; no browser facilities\)/,
    );
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
      " /** Fresh positive readiness",
    ),
    ACTUAL_PROBE: between(
      plugin,
      " private void probe(",
      " /** Cloud refused this app",
    ),
  });
  try {
    assert.match(
      runJvm(
        [...pure, ...support, file],
        "ai.eliza.auth.cloud.CloudSignInReadinessTest",
      ),
      /^PASS native readiness measure/,
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
  for (const product of [/Alpha/, /elizaresearch/, /BuildConfig/])
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
    "private void burnUnclaimedPending()",
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
      capture.indexOf("store.remove(config().pendingSlot)"),
  );
  assert.ok(
    capture.indexOf("store.remove(config().pendingSlot)") <
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
    tail.indexOf("reserveCredentialCommit()") < key,
    "the host fence is reserved before the key write",
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
    /if \(now < Math\.max\(lastEmailSendAt \+ CloudSignInFlow\.RESEND_COOLDOWN_MS, emailSendAllowedAt\)\)/,
  );
  assert.ok(
    plugin.indexOf(
      "emailSendAllowedAt = Math.max(emailSendAllowedAt, resendAt)",
    ) <
      plugin.indexOf(
        'if (sent.status != 200 && sent.status != 202) throw new SignInFailure(CloudSignInFlow.failureForStatus("send"',
      ),
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
