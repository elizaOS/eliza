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
      " /** Cancelled, ended or consumed",
    ),
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
      /^PASS native sign-in chain \(27 scenarios; no browser facilities\)/,
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
