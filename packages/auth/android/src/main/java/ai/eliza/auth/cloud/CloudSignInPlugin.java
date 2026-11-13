package ai.eliza.auth.cloud;

import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.content.pm.verify.domain.DomainVerificationManager;
import android.content.pm.verify.domain.DomainVerificationUserState;
import android.os.Build;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Native Eliza Cloud sign-in for a registered Android application. Native screens collect an email
 * or phone code or use the host-selected Google account picker or external browser; no hosted
 * Eliza Cloud login page is part of sign-in. Every secret-bearing request (Steward code exchange or email/SMS/MFA
 * verification, mobile App Auth connect, token and ack, Steward logout) is made here with fixed URLs
 * (CloudSignInRoutes). The Steward session, refresh token, authorization codes and PKCE verifiers
 * never cross the bridge; the Steward session is revoked after one sign-in and never stored.
 *
 * The host subclass declares the Capacitor plugin name and supplies its registration
 * ({@link #registration()}: client id, device label, product name, admitted deployments and installed
 * storage names), its protected credential storage ({@link #credentials(Runnable)}) and, optionally, a
 * credential intent reserved when an attempt is accepted ({@link #reserveCredentialCommit()}).
 *
 * The resulting `eliza_mobile_` key is written to the host's credential slot for the environment
 * after a durable acknowledgement receipt. An acknowledgement Cloud did not answer is asked again in
 * this process until its deadline, and again on the next start; in both, a key Cloud refused or did
 * not confirm in time is removed and reported (`activation-expired`), and a late confirmation is
 * announced (`signInCompleted`). Plugin call results carry no secret. A key a new sign-in replaces is
 * revoked best effort after the new key is stored and its acknowledgement was tried; an unconfirmed
 * revocation is retried twice in memory, never from storage. A key a renewal replaces is different:
 * the duty to revoke it is stored before the new key is saved and is retried on later starts until
 * Cloud no longer accepts that key.
 *
 * Readiness: status() reports each method only after CloudSignInReadiness confirms Cloud is ready for
 * this app. Ready methods are cached; a method that is not ready is measured again on a short TTL,
 * and when Android finishes verifying the return link. A fresh cached answer is always served at once:
 * the measurement runs behind it and a change follows as `signInReadinessChanged`; a measurement that
 * got no result keeps the cached methods. Resume measures only while a sign-in screen asked recently,
 * with a growing wait. On a Home (launcher) host a browser Google attempt ends only by its return, an
 * explicit cancel or its ten-minute expiry: the page is in the browser's own task and pressing Home
 * does not end it. On any other host the page is in the host's task, and returning to the host
 * without a result ends the attempt as `browser-closed`. Returns follow the shared callback contract (CloudSignInFlow.parseCallback).
 * Native Google diagnostics contain only bounded stage/status/timing, never URLs, codes, headers or
 * bodies.
 *
 * Renewal: a saved key near its expiry is renewed silently (`renewSignIn`, and a check on load and
 * resume) when the host can observe its credential intent ({@link #observeCredentialCommit()}). The
 * new key replaces the saved one only after Cloud confirmed it, and the old key is revoked only
 * after that, naming the new key so Cloud ends the old one alone; a refusal leaves the working key
 * alone, and a new key that was not saved is never revoked while the key it came from is still the
 * saved one (to Cloud that would be a sign-out of both). A browser Google return that arrives in a new
 * process completes only when the host keeps a durable credential generation
 * ({@link #credentialGeneration()}, {@link #adoptCredentialCommit(String)}); otherwise it completes
 * nothing.
 */
public abstract class CloudSignInPlugin extends Plugin {
 private static final int RESPONSE_LIMIT = 256 * 1024;
 private static final long BROWSER_RETURN_GRACE_MS = 1500;
 /** Delays before retrying an unconfirmed revocation of a replaced key (in memory only). */
 private static final long[] REVOCATION_RETRY_MS = {5000, 25000};

 /** Thrown with a stable, non-secret code the renderer maps to copy. */
 public static final class SignInFailure extends Exception {
  public final String code;
  SignInFailure(String code) { super(code); this.code = code; }
 }
 /** The one sign-in in progress. One at a time (the renderer's `login-active` rule). */
 private static final class Attempt {
  final String id = UUID.randomUUID().toString();
  final long startedAt = System.currentTimeMillis();
  final CloudSignInEnvironment environment;
  final boolean google;
  /** Renderer correlation only; never account or credential authority. */
  final String requestId;
  /** A code attempt holds a credential intent only once its code is sent (startEmail/startPhone). */
  volatile Runnable credentialGuard;
  /** A parameterless return arrived: only a hint, since any app can send one. */
  volatile boolean cancelled, callbackReceived, browserLaunched, browserPaused, returnHint;
  /** Guarded by lock. The browser page was opened in the host's own task (any host that is not the Home app). */
  boolean browserInHostTask;
  /** Guarded by lock. A recognized return is waiting for its storage read. */
  boolean returnClaimed, returnHintElapsed;
  /** Set before the attempt is published. Created in a new process for a browser return, with the intent that wrote its record; no call waits for it. */
  boolean adopted;
  String browserState, pendingRecord;
  volatile HttpURLConnection connection;
  volatile android.os.CancellationSignal googleCancellation;
  String googleVerifier, googleChallengeId;
  PluginCall waiting;
  volatile CountDownLatch authorizationDecision;
  volatile boolean authorized;
  String email, phone, emailVerifier, mfaType, mfaChallenge;
  long expiresAt, resendAt;
  int failedVerifies;
  boolean busy;
  Attempt(CloudSignInEnvironment environment, boolean google, String requestId, Runnable credentialGuard) {
   this.environment = environment; this.google = google; this.requestId = requestId; this.credentialGuard = credentialGuard;
  }
  void cancel() { cancelled = true; CountDownLatch decision = authorizationDecision; if (decision != null) decision.countDown(); android.os.CancellationSignal picker = googleCancellation; if (picker != null) picker.cancel(); googleVerifier = null; googleChallengeId = null; HttpURLConnection current = connection; if (current != null) current.disconnect(); }
 }
 private static final class Response {
  final int status; final JSONObject data; final String location, retryAfter;
  Response(int status, JSONObject data, String location) { this(status, data, location, null); }
  Response(int status, JSONObject data, String location, String retryAfter) { this.status = status; this.data = data; this.location = location; this.retryAfter = retryAfter; }
 }
 private final Object lock = new Object();
 private final ExecutorService worker = Executors.newSingleThreadExecutor();
 /** Readiness probes run apart from sign-in work, so a slow probe never delays a sign-in step. */
 private final ExecutorService prober = Executors.newSingleThreadExecutor();
 /** Startup acknowledgement requests run apart from sign-in work, so a slow request never delays a sign-in step. */
 private final ExecutorService recovery = Executors.newSingleThreadExecutor();
 /** Silent key renewal runs apart from sign-in work and from acknowledgement requests: it never delays either. */
 private final ExecutorService renewer = Executors.newSingleThreadExecutor();
 private final Handler main = new Handler(Looper.getMainLooper());
 private final Map<String, CloudSignInReadiness.Result> readiness = new HashMap<>();
 private final Map<String, List<PluginCall>> probing = new HashMap<>();
 /** Deployments whose unverified return link is being watched. Guarded by lock. */
 private final Set<String> linkWatch = new HashSet<>();
 /** Deployments whose stored key still waits for Cloud's acknowledgement in this process. Guarded by lock. */
 private final Set<String> activating = new HashSet<>();
 private volatile Attempt attempt;
 /** The browser state of the last cancelled Google attempt, so a return queued behind the cancel stays quiet. */
 private String cancelledBrowserState;
 /** Failed retirement cannot authorize another callback in this process. */
 private boolean pendingRetirementUnconfirmed;
 /** The local minimum between two code sends applies across email and SMS (lastEmailSendAt). A longer
  * wait supplied by Cloud belongs to the method that was asked: an SMS limit never blocks an email code. */
 private long lastEmailSendAt, emailSendAllowedAt, smsSendAllowedAt;
 /** When a sign-in screen last asked for status. Guarded by lock. */
 private long statusAskedAt;
 private volatile boolean destroyed;
 private CloudSignInConfig config;

 /** The host's registration. Called once; the result is kept for the plugin's lifetime. */
 protected abstract CloudSignInConfig registration();
 /** The host's protected credential slots. The store calls {@code guard} before every write and removal. */
 protected abstract CloudCredentialSlots credentials(Runnable guard);
 /** Run a read/delivery under the same lifecycle then vault locks as credential writes.
  * The callback performs no I/O other than local credential reads and bridge queueing. */
 protected abstract <T> T withCredentialRead(java.util.concurrent.Callable<T> read) throws Exception;

 /** Current installed identity only; no credential, account or provider authority crosses the bridge. */
 @PluginMethod public void credentialIdentity(PluginCall call) {
  final CloudSignInEnvironment environment;
  try { environment = config().environment(call.getString("environment")); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  final String slot = config().credentialSlot(environment);
  run(() -> {
   try {
    withCredentialRead(() -> {
     if (destroyed) throw new IllegalStateException("Sign-in closed");
     String saved = credentials(() -> {}).read(slot);
     String id = null;
     if (saved != null) {
      JSONObject value = new JSONObject(saved);
      String candidate = value.optString("credentialId", null);
      if (CloudSignInFlow.validUuid(candidate) && instant(value.opt("expiresAt")) > System.currentTimeMillis()) id = candidate;
     }
     call.resolve(new JSObject().put("environment", environment.name).put("credentialId", id == null ? JSONObject.NULL : id));
     return null;
    });
   } catch (Exception unavailable) { call.reject("Saved sign-in could not be read", "storage"); }
  });
 }

 /**
  * Called once when an explicit attempt is accepted, before asynchronous work. Its check stays
  * with that attempt through verification/MFA and rejects a later write after another credential
  * action supersedes it. Completion must never reserve a new intent. The default admits the write.
  */
 protected Runnable reserveCredentialCommit() { return () -> {}; }
 /**
  * A check bound to the newest credential intent at the time of the call. It reserves nothing, so
  * background work (silent key renewal) never supersedes an owner's action, and it throws once any
  * credential action has been reserved since. Null, the default, means the host has no such check:
  * the saved key is then never renewed in the background.
  */
 protected Runnable observeCredentialCommit() { return null; }
 /**
  * The host's durable credential generation: a value that changes whenever a credential action is
  * reserved and that survives the process (`[A-Za-z0-9_-]{1,128}`). Read after an accepted browser
  * Google attempt reserved its intent and stored with its pending record. Null, the default, means the
  * host keeps none: a browser return in a new process then completes nothing.
  */
 protected String credentialGeneration() { return null; }
 /**
  * For a browser return in a process that did not start the sign-in. When {@code generation} is still
  * the host's durable credential generation (no credential action was reserved since the pending
  * record was written, in that process or any later one), returns a check bound to the current
  * intent without reserving a new one; otherwise null. The default refuses.
  *
  * The generation is only as durable as the host's record of it. A host that reserves an intent for a
  * sign-out or reset must also remove the pending slot in that action, so that a reservation whose
  * record could not be written (storage full) still leaves nothing to adopt.
  */
 protected Runnable adoptCredentialCommit(String generation) { return null; }
 /**
  * Called on the renewal worker after a renewed key was saved (`credentialId` is its new local
  * identity) and before the key it replaced is revoked and `signInRenewed` is sent. To the host's
  * store the renewed key is a different credential: a store that binds a local agent to the saved key
  * stops that agent and removes its provider admission on this write, exactly as for a new sign-in. A
  * host with such an agent admits it again here, so that does not depend on a renderer listening at
  * that moment. May block. A failure is ignored: the old key is revoked and the renderer is told
  * either way. The default does nothing.
  */
 protected void savedKeyRenewed(CloudSignInEnvironment environment, String credentialId) throws Exception {}
 protected final CloudSignInConfig config() {
  synchronized (lock) { if (config == null) config = registration(); return config; }
 }

 @Override public void load() {
  super.load();
  // A browser return that starts the process (a sign-in an earlier build began in the browser) is
  // matched against the encrypted pending record. A plain start leaves that record alone: it expires
  // on its own, and a launcher restart must not discard a sign-in still in the browser.
  captureCallback(getActivity().getIntent());
  run(this::resumeAcknowledgements);
  // Warm the cached readiness answer so opening sign-in rarely waits for it.
  probe(config().defaultEnvironment(), null, false, true);
  renewSaved();
 }
 @Override protected void handleOnNewIntent(Intent intent) { super.handleOnNewIntent(intent); captureCallback(intent); }
 /** A browser page opened in the host's own task covers the host; see handleOnResume. */
 @Override protected void handleOnPause() {
  synchronized (lock) { if (attempt != null && attempt.browserLaunched && attempt.browserInHostTask) attempt.browserPaused = true; }
  super.handleOnPause();
 }
 /**
  * A browser Google page in the host's own task (every host that is not the Home app) was covering
  * the host: coming back without a return means the page was closed, and the attempt ends as
  * `browser-closed` after a short grace for a return that is still on its way. On a Home host the
  * page is in the browser's own task (Home, the app switcher, "open in browser" all leave it open),
  * so resuming never ends that attempt: it ends by its return, an explicit cancel or its expiry.
  *
  * A method that was not ready is measured again only while a sign-in screen asked for status
  * recently or an attempt is in progress, and then on a growing wait, so a launcher that is resumed
  * all day sends nothing. A saved key near its expiry is renewed.
  */
 @Override protected void handleOnResume() {
  super.handleOnResume();
  final Attempt current; final boolean measure;
  synchronized (lock) { current = attempt; measure = CloudSignInReadiness.resumeProbe(System.currentTimeMillis(), statusAskedAt, current != null); }
  if (measure) probe(config().defaultEnvironment(), null, false, true);
  renewSaved();
  if (current == null || !current.browserPaused) return;
  main.postDelayed(() -> {
   synchronized (lock) {
    if (attempt != current || current.cancelled || current.callbackReceived || current.returnHint || current.returnClaimed) return;
    end(current, "browser-closed", true);
   }
  }, BROWSER_RETURN_GRACE_MS);
 }
 @Override protected void handleOnDestroy() {
  destroyed = true;
  synchronized (lock) { if (attempt != null) attempt.cancel(); attempt = null; }
  worker.shutdownNow();
  prober.shutdownNow();
  recovery.shutdownNow();
  renewer.shutdownNow();
  super.handleOnDestroy();
 }
 private void run(Runnable task) {
  try { worker.execute(task); } catch (java.util.concurrent.RejectedExecutionException closed) { /* Activity teardown. */ }
 }
 private CloudCredentialSlots store() {
  return credentials(() -> { if (destroyed) throw new IllegalStateException("Sign-in closed"); });
 }

 // ── Readiness: each method only once Cloud is ready for this app ───────────────────────────

 /** Public provider documents come only from this build's configured API origin. */
 @PluginMethod public void serviceInfo(PluginCall call) {
  final CloudSignInEnvironment environment;
  try { environment = config().environment(call.getString("environment", config().defaultEnvironment().name)); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  try {
   prober.execute(() -> {
    try {
     Response response = get(environment.api() + "/api/public/service");
     if (response.status != 200) { call.reject("Service information unavailable", "unavailable"); return; }
     call.resolve(JSObject.fromJSONObject(response.data));
    } catch (Exception unavailable) { call.reject("Service information unavailable", "unavailable"); }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { call.reject("Sign-in closed", "unavailable"); }
 }
 @PluginMethod public void status(PluginCall call) {
  final CloudSignInEnvironment environment;
  try { environment = config().environment(call.getString("environment", config().defaultEnvironment().name)); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  synchronized (lock) { statusAskedAt = System.currentTimeMillis(); }
  probe(environment, call, Boolean.TRUE.equals(call.getBoolean("refreshNegative", false)), false);
 }
 private JSObject statusOutcome(CloudSignInEnvironment environment, CloudSignInReadiness.Result result) {
  synchronized (lock) {
   JSObject out = new JSObject().put("active", attempt != null);
   if (attempt != null) out.put("kind", attempt.google ? "google" : attempt.mfaType != null ? "mfa" : attempt.phone != null ? "phone" : "email");
   // A key is stored but Cloud has not confirmed it yet: it is not a usable sign-in until signInCompleted.
   if (activating.contains(environment.name)) out.put("activationPending", true);
   return out.put("methodsKnown", result.methodsKnown).put("inApp", result.inApp).put("email", result.email).put("phone", result.phone).put("google", result.google);
  }
 }
 /**
  * A fresh cached answer is served at once, whatever is due. When a method is not ready and its wait
  * has ended (the short TTL for a sign-in screen, the growing one for load and resume), it is measured
  * behind that answer and a change follows as `signInReadinessChanged`. A call waits for a
  * measurement only when there is no fresh answer or on an explicit Retry of an incomplete one.
  * Concurrent callers join one probe per environment. A measurement that got no result (no
  * connection, a timeout, a gateway error or a rate limit) keeps a fresh answer's methods and
  * announces nothing: only the next measurement is put off. The same holds for one method whose own
  * request got no usable answer while the others were measured (measure).
  */
 private void probe(CloudSignInEnvironment environment, PluginCall asked, boolean refreshNegative, boolean passive) {
  long now = System.currentTimeMillis();
  CloudSignInReadiness.Result cached;
  PluginCall call = asked;
  synchronized (lock) {
   cached = readiness.get(environment.name);
   if (cached == null) { cached = storedReadiness(environment); if (cached != null) readiness.put(environment.name, cached); }
   if (cached != null && cached.fresh(now) && (cached.complete() || !refreshNegative)) {
    if (call != null) { call.resolve(statusOutcome(environment, cached)); call = null; }
    if (cached.complete() || !(passive ? cached.passiveDue(now) : cached.recheckDue(now))) return;
   }
   List<PluginCall> waiting = probing.get(environment.name);
   if (waiting != null) { if (call != null) waiting.add(call); return; }
   waiting = new ArrayList<>(); if (call != null) waiting.add(call); probing.put(environment.name, waiting);
  }
  final CloudSignInReadiness.Result previous = cached;
  try {
   prober.execute(() -> {
    CloudSignInReadiness.Result result;
    try {
     result = measure(environment, previous);
     if (previous != null) result = result.repeated(previous, System.currentTimeMillis());
    } catch (Exception failure) {
     long at = System.currentTimeMillis();
     result = previous != null && previous.fresh(at) ? previous.unmeasured(at) : CloudSignInReadiness.Result.notReady(at);
    }
    List<PluginCall> answered;
    synchronized (lock) { readiness.put(environment.name, result); answered = probing.remove(environment.name); }
    storeReadiness(environment, result);
    if (answered != null) for (PluginCall waiting : answered) waiting.resolve(statusOutcome(environment, result));
    readinessMeasured(environment, previous, result);
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) {
   List<PluginCall> answered;
   synchronized (lock) { answered = probing.remove(environment.name); }
   if (answered != null) for (PluginCall waiting : answered) waiting.resolve(statusOutcome(environment, CloudSignInReadiness.Result.notReady(now)));
  }
 }
 /** Tells the renderer when a method's readiness changed since the answer it may hold, and watches a
  * return link Android has not verified yet (a fresh install verifies it some time after first launch). */
 private void readinessMeasured(CloudSignInEnvironment environment, CloudSignInReadiness.Result previous, CloudSignInReadiness.Result result) {
  if (previous != null && !result.sameMethods(previous)) notifyListeners("signInReadinessChanged", statusOutcome(environment, result).put("environment", environment.name), false);
  if (!result.google && linkPending(environment)) watchLink(environment, 0);
 }
 /** Browser Google is held back only by Android's verification of the return link. Local reads only. */
 private boolean linkPending(CloudSignInEnvironment environment) {
  return "browser".equals(config().googleSignInMode) && (browserPackage() != null || defaultBrowserPackage() != null) && !appLinkVerified(environment);
 }
 /** Bounded local checks of the return link (CloudSignInReadiness.LINK_WATCH_MS); no request is sent
  * until Android reports it verified, then readiness is measured once. One watch per environment. */
 private void watchLink(CloudSignInEnvironment environment, int round) {
  synchronized (lock) {
   if (destroyed || round == 0 && !linkWatch.add(environment.name)) return;
   if (round >= CloudSignInReadiness.LINK_WATCH_MS.length) { linkWatch.remove(environment.name); return; }
  }
  main.postDelayed(() -> {
   try {
    prober.execute(() -> {
     if (destroyed) return;
     if (!appLinkVerified(environment)) { watchLink(environment, round + 1); return; }
     synchronized (lock) { linkWatch.remove(environment.name); }
     probe(environment, null, true, false);
    });
   } catch (java.util.concurrent.RejectedExecutionException closed) { /* Activity teardown. */ }
  }, CloudSignInReadiness.LINK_WATCH_MS[round]);
 }
 /** Cloud refused this app's native sign-in: invalidate the readiness cache. */
 private void forgetReadiness(CloudSignInEnvironment environment) {
  synchronized (lock) { readiness.remove(environment.name); }
  try { getContext().getSharedPreferences(config().readinessPreferences + "-" + config().googleSignInMode, android.content.Context.MODE_PRIVATE).edit().remove(environment.name).apply(); } catch (Exception ignored) { /* Re-probed anyway. */ }
 }
 private CloudSignInReadiness.Result storedReadiness(CloudSignInEnvironment environment) {
  try { return CloudSignInReadiness.Result.parse(getContext().getSharedPreferences(config().readinessPreferences + "-" + config().googleSignInMode, android.content.Context.MODE_PRIVATE).getString(environment.name, null)); }
  catch (Exception unreadable) { return null; }
 }
 private void storeReadiness(CloudSignInEnvironment environment, CloudSignInReadiness.Result result) {
  try { getContext().getSharedPreferences(config().readinessPreferences + "-" + config().googleSignInMode, android.content.Context.MODE_PRIVATE).edit().putString(environment.name, result.serialize()).apply(); }
  catch (Exception ignored) { /* Kept in memory. */ }
 }
 /** Non-secret renewal bookkeeping (CloudKeyRenewal.Record), in memory and in plain preferences. */
 private final Map<String, CloudKeyRenewal.Record> renewalRecords = new HashMap<>();
 private CloudKeyRenewal.Record renewalRecord(CloudSignInEnvironment environment) {
  synchronized (renewalRecords) {
   // Another plugin instance may have committed a request since this instance last checked.
   try {
    CloudKeyRenewal.Record known = CloudKeyRenewal.Record.parse(getContext().getSharedPreferences(config().readinessPreferences + "-renewal", android.content.Context.MODE_PRIVATE).getString(environment.name, null));
    if (known == null) renewalRecords.remove(environment.name); else renewalRecords.put(environment.name, known);
    return known;
   } catch (Exception unreadable) { throw new IllegalStateException("Renewal bookkeeping is unavailable", unreadable); }
  }
 }
 private boolean storeRenewalRecord(CloudSignInEnvironment environment, CloudKeyRenewal.Record record) {
  synchronized (renewalRecords) {
   try {
    if (!getContext().getSharedPreferences(config().readinessPreferences + "-renewal", android.content.Context.MODE_PRIVATE).edit().putString(environment.name, record.serialize()).commit()) return false;
    renewalRecords.put(environment.name, record);
    return true;
   } catch (Exception unavailable) { return false; }
  }
 }
 /**
  * The readiness observations (CloudSignInReadiness). Every read is short and fixed.
  *
  * A method is measured not ready only by an answer that says so. A request with no usable answer
  * (no connection, a timeout, 5xx, 408 or 429) measures nothing: for the registration or the
  * providers read this throws, so the caller keeps its fresh answer whole; for the email route or the
  * browser Google reads, that one method keeps what `previous` said while it is fresh.
  */
 private CloudSignInReadiness.Result measure(CloudSignInEnvironment environment, CloudSignInReadiness.Result previous) throws Exception {
  long now = System.currentTimeMillis();
  Response registration = get(environment.api() + "/api/v1/app-auth/mobile/config?clientId=" + Uri.encode(config().clientId)
   + "&environment=" + environment.name + "&redirectUri=" + Uri.encode(environment.callback()));
  boolean registered = CloudSignInReadiness.registered(registration.status, registration.data.opt("success"), registration.data.optString("clientId", null),
   registration.data.optString("environment", null), registration.data.optString("redirectUri", null), registration.data.optString("codeChallengeMethod", null), config(), environment);
  if (CloudSignInReadiness.unanswered(registration.status)) throw new SignInFailure("unavailable");
  if (!registered) return CloudSignInReadiness.Result.notReady(now);
  Response providers = get(environment.api() + "/steward/auth/providers?tenantId=" + Uri.encode(environment.tenant));
  if (CloudSignInReadiness.unanswered(providers.status)) throw new SignInFailure("unavailable");
  if (providers.status != 200) return CloudSignInReadiness.Result.notReady(now);
  JSONObject captcha = providers.data.optJSONObject("captcha");
  JSONArray required = captcha == null ? null : captcha.optJSONArray("requiredFor");
  List<String> requiredFor = required == null ? null : new ArrayList<>();
  if (required != null) for (int i = 0; i < required.length(); i++) requiredFor.add(required.optString(i));
  boolean emailOffered = CloudSignInReadiness.emailOffered(providers.status, providers.data.opt("email"), captcha == null ? null : captcha.opt("enabled"), requiredFor);
  boolean phoneOffered = CloudSmsCode.offered(providers.status, providers.data.opt("sms"), captcha == null ? null : captcha.opt("enabled"), requiredFor);
  // An empty object names no address, so Steward refuses it and no email is sent. Null: no usable answer.
  Boolean emailReady = false;
  if (emailOffered) {
   try { int route = probePost(environment, CloudEmailCode.SEND_PATH); emailReady = route >= 500 ? null : (Boolean) CloudSignInReadiness.emailRoutePresent(route); }
   catch (Exception unanswered) { emailReady = null; /* Other methods remain independent. */ }
  }
  // Native Google verifies an ID token and does not require a browser return.
  Boolean googleReady = Boolean.TRUE.equals(providers.data.opt("googleNative"));
  if ("browser".equals(config().googleSignInMode)) {
   googleReady = false;
   if (Boolean.TRUE.equals(providers.data.opt("google")) && (browserPackage() != null || defaultBrowserPackage() != null) && appLinkVerified(environment)) {
    try {
     Response browser = get(CloudSignInFlow.authorizeUrl(environment, CloudSignInFlow.s256(CloudSignInFlow.newVerifier()), CloudSignInFlow.newState()));
     if (CloudSignInReadiness.unanswered(browser.status)) googleReady = null;
     else if (CloudSignInReadiness.redirectAllowed(browser.status, browser.location)) googleReady = assetLinksGranted(environment);
    } catch (Exception unanswered) { googleReady = null; /* Other sign-in methods remain independent. */ }
   }
  }
  return CloudSignInReadiness.Result.measured(emailReady, googleReady, phoneOffered, previous, now);
 }
 // ── Google: native Credential Manager with server-bound nonce and PKCE ────────────────────

 /** A real external Custom Tabs browser only. The host's WebView is never an OAuth user agent. */
 private String browserPackage() {
  try {
   List<String> candidates = new ArrayList<>();
   PackageManager manager = getContext().getPackageManager();
   Intent service = new Intent("android.support.customtabs.action.CustomTabsService");
   for (ResolveInfo resolved : manager.queryIntentServices(service, 0)) {
    if (resolved.serviceInfo == null || !resolved.serviceInfo.exported) continue;
    String name = resolved.serviceInfo.packageName;
    if (name == null || name.equals(getContext().getPackageName()) || candidates.contains(name)) continue;
    Intent page = new Intent(Intent.ACTION_VIEW, Uri.parse("https://accounts.google.com/"))
     .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(name);
    if (!manager.queryIntentActivities(page, PackageManager.MATCH_DEFAULT_ONLY).isEmpty()) candidates.add(name);
   }
   String browser = CustomTabsClient.getPackageName(getContext(), candidates);
   return candidates.contains(browser) ? browser : null;
  } catch (RuntimeException unavailable) { return null; }
 }
 /**
  * Without a Custom Tabs provider (stock AOSP ships only the WebView shell browser), the default
  * external HTTPS browser, opened with a plain VIEW as AppAuth does. Never the host itself.
  */
 private String defaultBrowserPackage() {
  try {
   PackageManager manager = getContext().getPackageManager();
   Intent page = new Intent(Intent.ACTION_VIEW, Uri.parse("https://accounts.google.com/")).addCategory(Intent.CATEGORY_BROWSABLE);
   List<String> handlers = new ArrayList<>();
   for (ResolveInfo resolved : manager.queryIntentActivities(page, PackageManager.MATCH_DEFAULT_ONLY)) {
    String name = resolved.activityInfo == null ? null : resolved.activityInfo.packageName;
    if (name != null && !name.equals(getContext().getPackageName()) && !handlers.contains(name)) handlers.add(name);
   }
   // With no default set the system resolver answers, which is not a handler: use the first browser.
   ResolveInfo preferred = manager.resolveActivity(page, PackageManager.MATCH_DEFAULT_ONLY);
   String chosen = preferred == null || preferred.activityInfo == null ? null : preferred.activityInfo.packageName;
   return handlers.contains(chosen) ? chosen : handlers.isEmpty() ? null : handlers.get(0);
  } catch (RuntimeException unavailable) { return null; }
 }
 private boolean appLinkVerified(CloudSignInEnvironment environment) {
  try {
   if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    DomainVerificationManager manager = getContext().getSystemService(DomainVerificationManager.class);
    DomainVerificationUserState state = manager == null ? null : manager.getDomainVerificationUserState(getContext().getPackageName());
    Integer host = state == null ? null : state.getHostToStateMap().get(environment.callbackHost);
    return state != null && state.isLinkHandlingAllowed() && host != null && host == DomainVerificationUserState.DOMAIN_STATE_VERIFIED;
   }
   Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(environment.callback())).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(getContext().getPackageName());
   return !getContext().getPackageManager().queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY).isEmpty();
  } catch (Exception unavailable) { return false; }
 }
 private boolean assetLinksGrant(CloudSignInEnvironment environment) { return Boolean.TRUE.equals(assetLinksGranted(environment)); }
 /** Whether the return host's statement list grants this app its links; null when the list got no usable answer just now. */
 private Boolean assetLinksGranted(CloudSignInEnvironment environment) {
  final Fetched response;
  try { response = fetch(new URI("https://" + environment.callbackHost + "/.well-known/assetlinks.json"), null, null); }
  catch (Exception unanswered) { return null; }
  if (CloudSignInReadiness.unanswered(response.status)) return null;
  try {
   if (response.status != 200) return false;
   Object parsed = new JSONTokener(response.body).nextValue();
   if (!(parsed instanceof JSONArray)) return false;
   JSONArray rows = (JSONArray) parsed;
   List<CloudSignInReadiness.Statement> statements = new ArrayList<>();
   for (int i = 0; i < rows.length() && i < 64; i++) {
    JSONObject row = rows.optJSONObject(i), target = row == null ? null : row.optJSONObject("target");
    if (target != null) statements.add(new CloudSignInReadiness.Statement(strings(row.optJSONArray("relation")), target.optString("namespace", null),
     target.optString("package_name", null), strings(target.optJSONArray("sha256_cert_fingerprints"))));
   }
   int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
   PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), flags);
   Signature[] signatures = Build.VERSION.SDK_INT >= 28 ? info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners() : info.signatures;
   Set<String> signers = new HashSet<>();
   if (signatures != null) for (Signature signature : signatures) {
    String fingerprint = CloudSignInReadiness.certificateFingerprint(signature.toByteArray());
    if (fingerprint != null) signers.add(fingerprint);
   }
   return CloudSignInReadiness.assetLinksGrant(statements, getContext().getPackageName(), signers);
  } catch (Exception unavailable) { return false; }
 }
 private static List<String> strings(JSONArray array) {
  List<String> values = new ArrayList<>();
  if (array != null) for (int i = 0; i < array.length() && i < 64; i++) values.add(array.optString(i));
  return values;
 }
 /** Browser mode remains an explicit host selection, never a fallback from a failed account picker. */
 private void startGoogleBrowser(Attempt next) {
  // Read after this attempt reserved its intent. A newer reservation in between fails the guarded write below.
  String generation = null;
  try { generation = credentialGeneration(); } catch (RuntimeException unavailable) { /* No durable generation: the first record format. */ }
  final CloudSignInFlow.Pending pending = CloudSignInFlow.Pending.create(next.environment, System.currentTimeMillis(), generation);
  next.browserState = pending.state; next.pendingRecord = pending.serialize(); next.expiresAt = pending.expiresAt; next.busy = true;
  synchronized (lock) { if (attempt != next || next.cancelled) return; pendingRetirementUnconfirmed = true; }
  expireBrowserAttempt(next, CloudSignInFlow.PENDING_TTL_MS);
  run(() -> {
   try {
    String tabs = browserPackage(), browser = tabs != null ? tabs : defaultBrowserPackage();
    if (browser == null) throw new SignInFailure("browser-unavailable");
    if (!appLinkVerified(next.environment) || !assetLinksGrant(next.environment)) throw new SignInFailure("app-link-unverified");
    credentials(() -> {
     if (destroyed || next.cancelled) throw new IllegalStateException("Sign-in closed");
     next.credentialGuard.run();
    }).write(config().pendingSlot, next.pendingRecord);
    synchronized (lock) {
     if (attempt != next || next.cancelled || destroyed) throw new SignInFailure("cancelled");
     pendingRetirementUnconfirmed = false;
    }
    String url = CloudSignInFlow.authorizeUrl(next.environment, CloudSignInFlow.s256(pending.verifier), pending.state);
    getActivity().runOnUiThread(() -> {
     // On a Home host the page opens in the browser's own task: Home returns to the host's
     // single-task activity, and Android would finish a page that sat above it in the host's task.
     // On any other host it stays in the host's task, where coming back without a return means it was closed.
     final boolean home = hostIsHome();
     synchronized (lock) {
      if (attempt != next || next.cancelled || destroyed) return;
      next.browserLaunched = true; next.browserInHostTask = !home;
     }
     try {
      final int task = home ? Intent.FLAG_ACTIVITY_NEW_TASK : 0;
      if (tabs == null) { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser).addFlags(task)); return; }
      CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).setShareState(CustomTabsIntent.SHARE_STATE_OFF).build();
      tab.intent.setPackage(browser).addFlags(task);
      tab.launchUrl(getActivity(), Uri.parse(url));
     } catch (RuntimeException unavailable) { end(next, "browser-unavailable", true); }
    });
   } catch (SignInFailure failure) { end(next, failure.code, true); }
   catch (Exception unavailable) { end(next, "unavailable", true); }
  });
 }

 /** The attempt's own deadline: with no return and no cancel it ends when its pending record
  * expires. A return being read at that moment decides first. */
 private void expireBrowserAttempt(Attempt next, long delay) {
  main.postDelayed(() -> {
   synchronized (lock) {
    if (attempt != next || next.cancelled || next.callbackReceived) return;
    if (next.returnClaimed) { expireBrowserAttempt(next, BROWSER_RETURN_GRACE_MS); return; }
   }
   end(next, "expired", true);
  }, delay);
 }
 /** The host is this device's Home app (a launcher host). */
 private boolean hostIsHome() {
  try {
   ResolveInfo home = getContext().getPackageManager().resolveActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DEFAULT_ONLY);
   return home != null && home.activityInfo != null && getContext().getPackageName().equals(home.activityInfo.packageName);
  } catch (RuntimeException unavailable) { return false; }
 }

 /** Optional caller identity scopes retained events to the interactive request that began them. */
 private static String callerRequestId(PluginCall call) throws SignInFailure {
  if (!call.getData().has("requestId")) return null;
  String value = call.getString("requestId");
  if (value == null || !CloudSignInFlow.validUuid(value)) throw new SignInFailure("invalid-request");
  return value;
 }

 @PluginMethod public void startGoogle(PluginCall call) {
  final CloudSignInEnvironment environment;
  try { environment = config().environment(call.getString("environment")); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  final String requestId;
  try { requestId = callerRequestId(call); }
  catch (SignInFailure invalid) { call.reject("Invalid sign-in request", "invalid-request"); return; }
  final Attempt next;
  synchronized (lock) {
   if (destroyed) { call.reject("Sign-in closed", "unavailable"); return; }
   if (attempt != null) { call.reject("Another sign-in is in progress", "login-active"); return; }
   next = new Attempt(environment, true, requestId, reserveCredentialCommit());
   attempt = next; next.waiting = call;
  }
  if ("browser".equals(config().googleSignInMode)) { startGoogleBrowser(next); return; }
  next.googleVerifier = CloudSignInFlow.newVerifier();
  next.googleCancellation = new android.os.CancellationSignal();
  next.busy = true;
  run(() -> {
   try {
    store().remove(config().pendingSlot);
    Response challenge = post(next, "/steward/auth/oauth/google/native/challenge", new JSONObject()
      .put("tenantId", environment.tenant).put("clientId", config().googleClientId)
      .put("codeChallenge", CloudSignInFlow.s256(next.googleVerifier)).put("codeChallengeMethod", "S256"), null);
    CloudSignInFlow.GoogleFailure challengeOutcome = observeGoogleResponse(next, CloudSignInFlow.GoogleStage.CHALLENGE, challenge);
    if (challenge.status != 200) throw new SignInFailure(challengeOutcome.code);
    JSONObject data = challenge.data;
    String challengeId = data.optString("challengeId", ""), nonce = data.optString("nonce", ""), clientId = data.optString("serverClientId", "");
    long expiresAt = instant(data.opt("expiresAt")), now = System.currentTimeMillis();
    if (!Boolean.TRUE.equals(data.opt("ok")) || challengeId.isEmpty() || challengeId.length() > 256
        || !nonce.matches("[A-Za-z0-9_-]{32,256}") || !clientId.matches("[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com")
        || expiresAt <= now || expiresAt > now + CloudSignInFlow.PENDING_TTL_MS) throw new SignInFailure("unavailable");
    synchronized (lock) {
     if (attempt != next || next.cancelled) throw new SignInFailure("cancelled");
     next.googleChallengeId = challengeId; next.expiresAt = expiresAt;
    }
    getActivity().runOnUiThread(() -> {
     synchronized (lock) { if (attempt != next || next.cancelled) return; }
     NativeGoogleCredential.request(getActivity(), clientId, nonce, next.googleCancellation, new NativeGoogleCredential.Callback() {
      @Override public void failure(String code) { end(next, code, false); }
      @Override public void token(String idToken) {
       run(() -> {
        try {
         synchronized (lock) { if (attempt != next || next.cancelled) throw new SignInFailure("cancelled"); }
         if (System.currentTimeMillis() >= next.expiresAt) {
          CloudSignInFlow.GoogleFailure expired = CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.LOCAL_DEADLINE, 0, null, null);
          logGoogleOutcome(next, CloudSignInFlow.GoogleStage.LOCAL_DEADLINE, 0, expired);
          throw new SignInFailure(expired.code);
         }
         Response verified = post(next, "/steward/auth/oauth/google/native/verify", new JSONObject()
           .put("tenantId", environment.tenant).put("clientId", config().googleClientId)
           .put("challengeId", next.googleChallengeId).put("idToken", idToken).put("codeVerifier", next.googleVerifier), null);
         next.googleVerifier = null; next.googleChallengeId = null; next.googleCancellation = null;
         CloudSignInFlow.GoogleFailure verifyOutcome = observeGoogleResponse(next, CloudSignInFlow.GoogleStage.VERIFY, verified);
         if (verified.status != 200) throw new SignInFailure(verifyOutcome.code);
         JSONObject session = verified.data.optJSONObject("data") != null && !verified.data.has("token") ? verified.data.optJSONObject("data") : verified.data;
         completeOrRequireMfa(next, session);
        } catch (SignInFailure failure) { end(next, failure.code, false); }
        catch (Exception unavailable) { end(next, "unavailable", false); }
       });
      }
     });
    });
   } catch (SignInFailure failure) { end(next, failure.code, false); }
   catch (Exception unavailable) { end(next, "unavailable", false); }
  });
 }
 /** Observe only the already received native Google response; never persist provider text. */
 private CloudSignInFlow.GoogleFailure observeGoogleResponse(Attempt current, CloudSignInFlow.GoogleStage stage, Response response) {
  CloudSignInFlow.GoogleFailure outcome = CloudSignInFlow.googleFailure(stage, response.status, response.data.opt("ok"), response.data.opt("error"));
  logGoogleOutcome(current, stage, response.status, outcome);
  return outcome;
 }
 private void logGoogleOutcome(Attempt current, CloudSignInFlow.GoogleStage stage, int status, CloudSignInFlow.GoogleFailure outcome) {
  android.util.Log.i(config().logTag, CloudSignInFlow.googleDiagnostic(stage, status, outcome, current.startedAt, current.expiresAt, System.currentTimeMillis()));
 }
 /**
  * Strict App Link capture under the shared callback contract. Only this environment's exact
  * callback is considered, and the intent's data is cleared so a relaunch never replays it.
  * - RETURN (no result, e.g. the fallback page's parameterless hand-off): only a hint, since any app
  *   can send one. Nothing is compared or burned; a SUCCESS or ERROR within the return grace still
  *   decides the waiting step, otherwise it ends with an honest retry message. The pending record
  *   stays until it expires or the owner starts again.
  * - SUCCESS or ERROR: the state is compared (constant time) before anything is burned. A state that
  *   does not match the pending record is ignored and leaves the attempt alone, so another app's
  *   intent cannot cancel a sign-in. A match burns the record before any network request.
  */
 private boolean captureCallback(Intent intent) {
  Uri data = intent == null ? null : intent.getData();
  if (data == null || !"https".equals(data.getScheme())) return false;
  CloudSignInEnvironment environment = null;
  CloudSignInFlow.Callback callback = null;
  for (CloudSignInEnvironment candidate : config().environments()) {
   CloudSignInFlow.Callback parsed = CloudSignInFlow.parseCallback(data.toString(), candidate);
   if (parsed != null) { environment = candidate; callback = parsed; break; }
  }
  if (callback == null) return false;
  intent.setData(null);
  final CloudSignInEnvironment returned = environment;
  final CloudSignInFlow.Callback received = callback;
  // Claim this attempt's return before the worker reads its pending record.
  final Attempt claimed;
  synchronized (lock) {
   claimed = !pendingRetirementUnconfirmed && attempt != null && attempt.google && attempt.browserLaunched
    && attempt.environment == returned && !attempt.cancelled && !attempt.callbackReceived && !attempt.returnClaimed
    && (received.kind == CloudSignInFlow.ReturnKind.RETURN || received.state != null && attempt.browserState != null
     && java.security.MessageDigest.isEqual(received.state.getBytes(StandardCharsets.US_ASCII), attempt.browserState.getBytes(StandardCharsets.US_ASCII)))
    ? attempt : null;
   if (claimed != null) claimed.returnClaimed = true;
  }
  run(() -> {
   try {
    CloudSignInFlow.Pending pending = null;
    String pendingRaw = null;
    synchronized (lock) { if (pendingRetirementUnconfirmed) return; }
    try { pendingRaw = store().read(config().pendingSlot); pending = CloudSignInFlow.Pending.parse(pendingRaw, config()); }
    catch (Exception storage) { /* Treated as no pending record. */ }
    long now = System.currentTimeMillis();
    final Attempt waiting;
    synchronized (lock) {
     if (pendingRetirementUnconfirmed) return;
     waiting = attempt;
     if (waiting != null && (!waiting.google || !waiting.browserLaunched || waiting.environment != returned || waiting.callbackReceived
       || !java.util.Objects.equals(waiting.pendingRecord, pendingRaw))) return;
    }
    if (received.kind == CloudSignInFlow.ReturnKind.RETURN) {
     if (pending == null || pending.environment != returned || pending.expired(now)) return;
     if (waiting == null) {
      synchronized (lock) { if (pending.state.equals(cancelledBrowserState)) return; }
      notifyListeners("signInIncomplete", new JSObject().put("code", "app-link-unverified"), true);
      return;
     }
     synchronized (lock) { waiting.returnHint = true; }
     main.postDelayed(() -> {
      synchronized (lock) {
       if (attempt != waiting || waiting.cancelled || waiting.callbackReceived) return;
       waiting.returnHintElapsed = true;
       if (!waiting.returnClaimed) end(waiting, "app-link-unverified", false);
      }
     }, BROWSER_RETURN_GRACE_MS);
     return;
    }
    // Not this device's request (unknown, foreign or duplicate): ignored, nothing burned or ended.
    if (pending == null || pending.environment != returned || !pending.sameState(received)) return;
    final Attempt owner;
    if (waiting != null) owner = waiting;
    else {
     // A return queued behind the owner's own cancel is not news to the owner.
     synchronized (lock) { if (pending.state.equals(cancelledBrowserState)) return; }
     // A return in a process that did not start the sign-in has no live credential intent. It
     // completes only with the intent that wrote this record, and only while the host confirms that
     // no credential action followed it; otherwise it authorizes nothing.
     owner = adoptReturn(pending, pendingRaw, now);
     if (owner == null) {
      notifyListeners("signInIncomplete", new JSObject().put("code", "app-link-unverified"), true);
      return;
     }
    }
    if (!pending.state.equals(owner.browserState)) return;
    // State and the original credential intent must both match before consuming the code.
    try {
     boolean consumed = credentials(() -> {
      if (destroyed || owner.cancelled) throw new IllegalStateException("Sign-in closed");
      owner.credentialGuard.run();
     }).compareExchange(config().pendingSlot, pendingRaw, null);
     if (!consumed) { synchronized (lock) { if (owner.adopted && attempt == owner) attempt = null; } return; }
    } catch (Exception storage) {
     synchronized (lock) { if (attempt != owner) return; pendingRetirementUnconfirmed = true; }
     end(owner, "storage", false); return;
    }
    synchronized (lock) {
     if (pendingRetirementUnconfirmed || attempt != owner || owner.cancelled) return;
     owner.callbackReceived = true;
    }
    if (pending.expired(now)) { end(owner, "expired", false); return; }
    owner.expiresAt = pending.expiresAt;
    owner.callbackReceived = true;
    if (received.kind == CloudSignInFlow.ReturnKind.ERROR) {
     end(owner, "mfa_required".equals(received.error) ? "mfa-browser" : "app_link_unverified".equals(received.error) ? "app-link-unverified" : "provider-refused", false);
     return;
    }
    try {
     JSONObject body = new JSONObject().put("code", received.code).put("redirectUri", returned.callback())
      .put("tenantId", returned.tenant).put("codeVerifier", pending.verifier);
     Response exchanged = post(owner, "/steward/auth/oauth/exchange", body, null);
     if (exchanged.status != 200) throw new SignInFailure(CloudSignInFlow.failureForStatus("exchange", exchanged.status));
     JSONObject session = exchanged.data.optJSONObject("data") != null && !exchanged.data.has("token") ? exchanged.data.optJSONObject("data") : exchanged.data;
     // No screen waits for a second factor of an adopted return: the owner uses the email code instead.
     if (owner.adopted && Boolean.TRUE.equals(session.opt("mfaRequired"))) throw new SignInFailure("mfa-browser");
     completeOrRequireMfa(owner, session);
    } catch (SignInFailure failure) { end(owner, failure.code, false); }
    catch (Exception unexpected) { end(owner, "unavailable", false); }
   } finally { releaseReturnClaim(claimed); }
  });
  return true;
 }
 /**
  * A return that arrives in a process that did not start the sign-in (Android ended the host while
  * the browser was in front). The pending record names the host's durable credential generation at
  * the time it was written. When the host confirms that generation is still the newest (no sign-out,
  * sign-in, provider change or reset was reserved since, in any process) the return is given an
  * attempt bound to that intent; nothing new is reserved. The record itself is state- and PKCE-bound
  * and encrypted at rest, and the Android authorization dialog still precedes the key. A record
  * without a generation, an expired one, a host without a durable generation and a running attempt
  * are all refused.
  */
 private Attempt adoptReturn(CloudSignInFlow.Pending pending, String pendingRaw, long now) {
  if (pending.generation == null || pending.expired(now)) return null;
  final Runnable guard;
  try { guard = adoptCredentialCommit(pending.generation); } catch (RuntimeException refused) { return null; }
  if (guard == null) return null;
  synchronized (lock) {
   if (destroyed || attempt != null || pendingRetirementUnconfirmed) return null;
   Attempt adopted = new Attempt(pending.environment, true, null, guard);
   adopted.adopted = true; adopted.browserLaunched = true; adopted.busy = true;
   adopted.browserState = pending.state; adopted.pendingRecord = pendingRaw; adopted.expiresAt = pending.expiresAt;
   attempt = adopted;
   return adopted;
  }
 }
 /** A recognized but unconsumable return releases its own elapsed grace. A page in the host's task
  * that was left for the host is closed (`browser-closed`). The attempt otherwise stays: the page can
  * still return while the pending record is valid. */
 private void releaseReturnClaim(Attempt claimed) {
  if (claimed == null) return;
  synchronized (lock) {
   claimed.returnClaimed = false;
   if (attempt != claimed || claimed.cancelled || claimed.callbackReceived) return;
   if (claimed.returnHintElapsed) end(claimed, "app-link-unverified", false);
   else if (claimed.browserPaused && !claimed.returnHint) end(claimed, "browser-closed", true);
  }
 }
 /** Retire only the captured record; a successor may already own the slot. */
 private void burnUnclaimedPending(Attempt owner) {
  run(() -> {
   try {
    String expected = owner.pendingRecord;
    if (expected == null) expected = store().read(config().pendingSlot);
    synchronized (lock) { if (attempt != null && attempt != owner) return; }
    CloudCredentialSlots slots = credentials(() -> {
     if (destroyed) throw new IllegalStateException("Sign-in closed");
     owner.credentialGuard.run();
    });
    if (expected != null) slots.compareExchange(config().pendingSlot, expected, null);
    synchronized (lock) { if (attempt == null) pendingRetirementUnconfirmed = false; }
   } catch (Exception ignored) { /* Unconfirmed retirement keeps callback admission fenced. */ }
  });
 }

 // ── Email code and MFA: fully native ─────────────────────────────────────────────────────────

 @PluginMethod public void startEmail(PluginCall call) {
  final CloudSignInEnvironment environment;
  final String email = call.getString("email") == null ? null : call.getString("email").trim().toLowerCase(java.util.Locale.ROOT);
  try { environment = config().environment(call.getString("environment")); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  final String requestId;
  try { requestId = callerRequestId(call); }
  catch (SignInFailure invalid) { call.reject("Invalid sign-in request", "invalid-request"); return; }
  if (!CloudSignInFlow.validEmail(email)) { call.reject("Enter a valid email address", "invalid-email"); return; }
  final Attempt current, previous;
  synchronized (lock) {
   if (destroyed) { call.reject("Sign-in closed", "unavailable"); return; }
   long now = System.currentTimeMillis();
   if (attempt != null && (attempt.google || attempt.busy)) { call.reject("Another sign-in is in progress", "login-active"); return; }
   // The minimum applies across addresses and methods; Cloud may require a longer wait for email codes.
   long allowedAt = Math.max(lastEmailSendAt + CloudSignInFlow.RESEND_COOLDOWN_MS, emailSendAllowedAt);
   if (now < allowedAt) { call.reject("Wait before requesting another code", "cooldown", sendWait(allowedAt)); return; }
   // A resend leaves the code already sent usable until the new one is out.
   previous = attempt != null && attempt.mfaType == null && attempt.expiresAt > now ? attempt : null;
   if (attempt != null && previous == null) attempt.cancel();
   current = new Attempt(environment, false, requestId, () -> { throw new IllegalStateException("Code not sent"); });
   current.email = email; current.emailVerifier = CloudSignInFlow.newVerifier(); current.busy = true; attempt = current;
  }
  final long[] wait = {0};
  run(() -> {
   try {
    Response sent = post(current, CloudEmailCode.SEND_PATH, CloudEmailCode.sendBody(config(), current.environment, email, current.emailVerifier), null);
    JSONObject data = sent.data.optJSONObject("data") != null ? sent.data.optJSONObject("data") : sent.data;
    long now = System.currentTimeMillis(), expiresAt = CloudEmailCode.expiresAt(data.opt("expiresAt"), now);
    long resendAt = CloudEmailCode.resendAt(data.opt("resendAt"), sent.retryAfter, now);
    // The request left the phone, so the cooldown starts here. A send with no answer starts none.
    synchronized (lock) { lastEmailSendAt = now; emailSendAllowedAt = Math.max(emailSendAllowedAt, resendAt); wait[0] = emailSendAllowedAt; }
    if (sent.status != 200 && sent.status != 202) throw new SignInFailure(CloudSignInFlow.failureForStatus("send", sent.status));
    synchronized (lock) {
     if (attempt != current || current.cancelled) throw new SignInFailure("cancelled");
     current.credentialGuard = reserveCredentialCommit();
     if (previous != null) previous.cancel();
     current.expiresAt = expiresAt; current.resendAt = emailSendAllowedAt; current.busy = false;
    }
    // A Google return this sign-in supersedes can no longer finish.
    burnUnclaimedPending(current);
    call.resolve(new JSObject().put("attemptId", current.id).put("expiresAt", expiresAt).put("resendAt", current.resendAt));
   } catch (SignInFailure failure) { notSent(current, previous); refused(current.environment, failure.code); sendRefused(call, failure.code, wait[0]); }
   catch (Exception unexpected) { notSent(current, previous); call.reject("unavailable", "unavailable"); }
  });
 }
 @PluginMethod public void startPhone(PluginCall call) {
  final CloudSignInEnvironment environment;
  final String phone = call.getString("phone") == null ? null : call.getString("phone").trim();
  try { environment = config().environment(call.getString("environment")); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  final String requestId;
  try { requestId = callerRequestId(call); }
  catch (SignInFailure invalid) { call.reject("Invalid sign-in request", "invalid-request"); return; }
  if (!CloudSmsCode.validPhone(phone)) { call.reject("Enter a phone number with country code", "invalid-phone"); return; }
  final Attempt current, previous;
  synchronized (lock) {
   if (destroyed) { call.reject("Sign-in closed", "unavailable"); return; }
   long now = System.currentTimeMillis();
   if (attempt != null && (attempt.google || attempt.busy)) { call.reject("Another sign-in is in progress", "login-active"); return; }
   // The local minimum applies across email and SMS, whatever the address. Cloud's longer wait for SMS
   // (a per-number limit can be an hour) applies to SMS only: the owner can still ask for an email code.
   long allowedAt = Math.max(lastEmailSendAt + CloudSignInFlow.RESEND_COOLDOWN_MS, smsSendAllowedAt);
   if (now < allowedAt) { call.reject("Wait before requesting another code", "cooldown", sendWait(allowedAt)); return; }
   previous = attempt != null && attempt.mfaType == null && attempt.expiresAt > now ? attempt : null;
   if (attempt != null && previous == null) attempt.cancel();
   current = new Attempt(environment, false, requestId, () -> { throw new IllegalStateException("Code not sent"); });
   current.phone = phone; current.busy = true; attempt = current;
  }
  final long[] wait = {0};
  run(() -> {
   try {
    requirePhoneAvailable(current);
    Response sent = post(current, CloudSmsCode.SEND_PATH, CloudSmsCode.sendBody(current.environment, phone), null);
    JSONObject data = sent.data.optJSONObject("data") != null ? sent.data.optJSONObject("data") : sent.data;
    long now = System.currentTimeMillis(), expiresAt = CloudEmailCode.expiresAt(data.opt("expiresAt"), now);
    // As for email: the answered request starts the cooldown, and Cloud's resend time or Retry-After
    // (also on a refusal) extends it, for SMS sends only.
    long resendAt = CloudEmailCode.resendAt(data.opt("resendAt"), sent.retryAfter, now);
    synchronized (lock) { lastEmailSendAt = now; smsSendAllowedAt = Math.max(smsSendAllowedAt, resendAt); wait[0] = smsSendAllowedAt; }
    if (sent.status != 200 && sent.status != 202) throw new SignInFailure(CloudSignInFlow.failureForStatus("send", sent.status));
    synchronized (lock) {
     if (attempt != current || current.cancelled) throw new SignInFailure("cancelled");
     current.credentialGuard = reserveCredentialCommit();
     if (previous != null) previous.cancel();
     current.expiresAt = expiresAt; current.resendAt = smsSendAllowedAt; current.busy = false;
    }
    burnUnclaimedPending(current);
    call.resolve(new JSObject().put("attemptId", current.id).put("expiresAt", expiresAt).put("resendAt", current.resendAt));
   } catch (SignInFailure failure) { notSent(current, previous); refused(current.environment, failure.code); sendRefused(call, failure.code, wait[0]); }
   catch (Exception unexpected) { notSent(current, previous); call.reject("unavailable", "unavailable"); }
  });
 }
 /** A failed send leaves the code already sent (if still live) as the attempt, so a failed resend strands nothing. */
 private void notSent(Attempt current, Attempt previous) {
  synchronized (lock) {
   current.busy = false;
   boolean restore = attempt == current && previous != null && !previous.cancelled && previous.expiresAt > System.currentTimeMillis();
   if (attempt == current) attempt = restore ? previous : null;
   if (!restore && previous != null) previous.cancel();
  }
 }
 /** When the next send of this method may be tried: the one datum a `cooldown` or refused send carries. */
 private static JSObject sendWait(long resendAt) { return new JSObject().put("resendAt", resendAt); }
 /** A send Cloud answered and refused says how long to wait; a send with no answer has nothing to say. */
 private static void sendRefused(PluginCall call, String code, long resendAt) {
  if (resendAt > 0) call.reject(code, code, sendWait(resendAt)); else call.reject(code, code);
 }
 /** Check registration and tenant SMS policy before sending a real code. No website alias or captcha bypass. */
 private void requirePhoneAvailable(Attempt current) throws Exception {
  CloudSignInEnvironment environment = current.environment;
  Response registration = get(environment.api() + "/api/v1/app-auth/mobile/config?clientId=" + Uri.encode(config().clientId)
   + "&environment=" + environment.name + "&redirectUri=" + Uri.encode(environment.callback()));
  if (!CloudSignInReadiness.registered(registration.status, registration.data.opt("success"), registration.data.optString("clientId", null),
   registration.data.optString("environment", null), registration.data.optString("redirectUri", null), registration.data.optString("codeChallengeMethod", null), config(), environment))
   throw new SignInFailure("unavailable");
  Response providers = get(environment.api() + "/steward/auth/providers?tenantId=" + Uri.encode(environment.tenant));
  JSONObject captcha = providers.data.optJSONObject("captcha");
  JSONArray required = captcha == null ? null : captcha.optJSONArray("requiredFor");
  List<String> requiredFor = required == null ? null : new ArrayList<>();
  if (required != null) for (int i = 0; i < required.length(); i++) requiredFor.add(required.optString(i));
  if (!CloudSmsCode.offered(providers.status, providers.data.opt("sms"), captcha == null ? null : captcha.opt("enabled"), requiredFor))
   throw new SignInFailure("unavailable");
  synchronized (lock) { if (attempt != current || current.cancelled) throw new SignInFailure("cancelled"); }
 }
 @PluginMethod public void verifyPhone(PluginCall call) { verify(call, false, true); }
 @PluginMethod public void verifyEmail(PluginCall call) { verify(call, false); }
 @PluginMethod public void verifyMfa(PluginCall call) { verify(call, true); }
 private void verify(PluginCall call, boolean mfa) { verify(call, mfa, false); }
 private void verify(PluginCall call, boolean mfa, boolean phone) {
  final String code = call.getString("code");
  if (!CloudSignInFlow.validCode(code)) { call.reject("Enter the six-digit code", "invalid-code"); return; }
  final Attempt current;
  synchronized (lock) {
   current = attempt;
   if (current == null || (current.google && !mfa) || !current.id.equals(call.getString("attemptId"))) { call.reject("Sign-in expired. Start again.", "expired"); return; }
   if (!mfa && phone != (current.phone != null)) { call.reject("Sign-in step changed. Start again.", "expired"); return; }
   if (current.busy) { call.reject("Another sign-in is in progress", "login-active"); return; }
   if (System.currentTimeMillis() >= current.expiresAt) { attempt = null; call.reject("Sign-in expired. Start again.", "expired"); return; }
   if (current.failedVerifies >= CloudSignInFlow.MAX_VERIFY_ATTEMPTS) { attempt = null; call.reject("Too many incorrect codes", "attempts-exhausted"); return; }
   if (mfa != (current.mfaType != null)) { call.reject("Sign-in step changed. Start again.", "expired"); return; }
   if (mfa && !("totp".equals(current.mfaType) || "sms".equals(current.mfaType))) { call.reject("Unsupported verification", "mfa-unsupported"); return; }
   current.busy = true; current.waiting = call;
  }
  run(() -> {
   boolean answered = false;
   try {
    Response verified = mfa
     ? post(current, "/steward/auth/mfa/" + current.mfaType + "/complete", new JSONObject().put("challengeId", current.mfaChallenge).put("code", code), null)
     : phone ? post(current, CloudSmsCode.VERIFY_PATH, CloudSmsCode.verifyBody(current.environment, current.phone, code), null)
     : post(current, CloudEmailCode.VERIFY_PATH, CloudEmailCode.verifyBody(config(), current.environment, current.email, code, current.emailVerifier), null);
    // A timeout, rate limit or server error says nothing about the code: it is handled as no answer.
    answered = !CloudSignInFlow.verifyRetryable(verified.status);
    if (verified.status != 200) throw new SignInFailure(CloudSignInFlow.failureForStatus(mfa ? "mfa" : "verify", verified.status));
    JSONObject session = verified.data.optJSONObject("data") != null && !verified.data.has("token") ? verified.data.optJSONObject("data") : verified.data;
    completeOrRequireMfa(current, session);
   } catch (SignInFailure failure) {
    boolean wrong = "invalid-code".equals(failure.code);
    if (!wrong && (answered || "cancelled".equals(failure.code))) { end(current, failure.code, false); return; }
    // A wrong code keeps the step for a retry, up to the per-attempt cap; then the attempt ends.
    // A request with no answer, or one Cloud could not serve (408, 429, 5xx), also keeps the step.
    // It is not counted: the code can still be correct. `attemptKept` tells the renderer so.
    boolean exhausted;
    synchronized (lock) {
     if (attempt != current || current.waiting != call) return;
     exhausted = wrong && ++current.failedVerifies >= CloudSignInFlow.MAX_VERIFY_ATTEMPTS;
     if (!exhausted) {
      current.waiting = null;
      current.busy = false;
     }
    }
    if (exhausted) { end(current, "attempts-exhausted", false); return; }
    call.reject(failure.code, failure.code, new JSObject().put("attemptKept", true));
   }
   catch (Exception unexpected) { end(current, "unavailable", false); }
  });
 }
 private void release(Attempt current) { synchronized (lock) { current.busy = false; if (attempt == current && current.expiresAt == 0) attempt = null; } }

 /** A retained MFA event is only a hint: the renderer must re-check its live attempt before displaying it. */
 @PluginMethod public void resumeMfa(PluginCall call) {
  synchronized (lock) {
   boolean active = attempt != null && !attempt.cancelled && attempt.mfaType != null
    && attempt.id.equals(call.getString("attemptId")) && attempt.environment.name.equals(call.getString("environment"))
    && attempt.expiresAt > System.currentTimeMillis();
   call.resolve(new JSObject().put("active", active));
  }
 }
 @PluginMethod public void clearCredentialState(PluginCall call) {
  getActivity().runOnUiThread(() -> NativeGoogleCredential.clear(getActivity(), () -> call.resolve()));
 }

 @PluginMethod public void cancel(PluginCall call) {
  final String requestId;
  try { requestId = callerRequestId(call); }
  catch (SignInFailure invalid) { call.reject("Invalid sign-in request", "invalid-request"); return; }
  final Attempt current;
  synchronized (lock) {
   if (requestId != null && (attempt == null || !requestId.equals(attempt.requestId))) { call.resolve(); return; }
   current = attempt;
  }
  String captured = null;
  Exception readFailure = null;
  try { captured = current != null && current.google ? current.pendingRecord : store().read(config().pendingSlot); }
  catch (Exception storage) { readFailure = storage; }
  synchronized (lock) {
   if (attempt != current) { call.resolve(); return; }
   attempt = null; pendingRetirementUnconfirmed = true;
   if (current != null && current.google) cancelledBrowserState = current.browserState;
  }
  if (current != null) { current.cancel(); PluginCall waiting; synchronized (lock) { waiting = current.waiting; current.waiting = null; } if (waiting != null) waiting.reject("cancelled", "cancelled"); }
  if (readFailure != null) { cancellationFailed(call); return; }
  final String pending = captured;
  try { worker.execute(() -> {
   try {
    if (pending != null) store().compareExchange(config().pendingSlot, pending, null);
    synchronized (lock) { if (attempt == null) pendingRetirementUnconfirmed = false; }
    call.resolve();
   } catch (Exception storage) { cancellationFailed(call); }
  }); } catch (java.util.concurrent.RejectedExecutionException closed) { cancellationFailed(call); }
 }
 private void cancellationFailed(PluginCall call) {
  notifyListeners("signInIncomplete", new JSObject().put("code", "storage"), true);
  call.reject("Pending sign-in cancellation was not saved", "storage");
 }

 /** Post-authentication consent is owned by Android, never a renderer-supplied boolean.
  * The worker retains the session only in memory while this bounded prompt is open.
  * Closing the activity, cancellation and expiration all refuse access. */
 private void requireAuthorization(Attempt current) throws Exception {
  CountDownLatch decision = new CountDownLatch(1);
  final AlertDialog[] shown = new AlertDialog[1];
  synchronized (lock) {
   if (attempt != current || current.cancelled || destroyed) throw new SignInFailure("cancelled");
   current.authorized = false;
   current.authorizationDecision = decision;
  }
  main.post(() -> {
   synchronized (lock) {
    if (attempt != current || current.cancelled || destroyed || System.currentTimeMillis() >= current.expiresAt
     || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()) { decision.countDown(); return; }
    String product = config().productName, service = current.environment.serviceName;
    try {
     shown[0] = new AlertDialog.Builder(getActivity())
      .setTitle("Authorize " + product)
      .setMessage("Allow " + product + " to access your account with " + service + " and use its services on this device? You can sign out in Settings.")
      .setPositiveButton("Authorize", (dialog, which) -> {
       synchronized (lock) {
        if (attempt == current && !current.cancelled && !destroyed && System.currentTimeMillis() < current.expiresAt) current.authorized = true;
       }
       decision.countDown();
      })
      .setNegativeButton("Cancel", (dialog, which) -> decision.countDown())
      .setOnCancelListener(dialog -> decision.countDown())
      .create();
     shown[0].setCanceledOnTouchOutside(false);
     shown[0].show();
    } catch (RuntimeException unavailable) { decision.countDown(); }
   }
  });
  try {
   long remaining = Math.max(0, current.expiresAt - System.currentTimeMillis());
   if (!decision.await(remaining, TimeUnit.MILLISECONDS)) throw new SignInFailure("expired");
   synchronized (lock) {
    if (System.currentTimeMillis() >= current.expiresAt) throw new SignInFailure("expired");
    if (attempt != current || current.cancelled || destroyed || !current.authorized) throw new SignInFailure("cancelled");
   }
  } finally {
   current.authorizationDecision = null;
   main.post(() -> { if (shown[0] != null) shown[0].dismiss(); });
  }
 }
 private void completeOrRequireMfa(Attempt current, JSONObject session) throws Exception {
  if (Boolean.TRUE.equals(session.opt("mfaRequired"))) {
   if (current.mfaType != null) throw new SignInFailure("unavailable");
   JSONObject challenge = session.optJSONObject("mfa");
   String type = challenge == null ? null : challenge.optString("type", null), id = challenge == null ? null : challenge.optString("challengeId", null);
   long expiresAt = challenge == null ? 0 : instant(challenge.opt("expiresAt"));
   if (id == null || id.isEmpty() || id.length() > 256 || expiresAt <= System.currentTimeMillis()
       || !("totp".equals(type) || "sms".equals(type) || "passkey".equals(type))) throw new SignInFailure("unavailable");
   synchronized (lock) {
    if (destroyed || attempt != current || current.cancelled || current.waiting == null) throw new SignInFailure("cancelled");
    current.mfaType = type; current.mfaChallenge = id; current.failedVerifies = 0;
    current.expiresAt = Math.min(current.expiresAt, expiresAt); current.busy = false;
    PluginCall waiting = current.waiting; current.waiting = null;
    JSObject required = new JSObject().put("status", "mfa").put("attemptId", current.id).put("environment", current.environment.name).put("method", type).put("expiresAt", current.expiresAt);
    if (current.requestId != null) required.put("requestId", current.requestId);
    waiting.resolve(required);
   }
   return;
  }
  complete(current, session);
 }

 // ── Shared tail: Steward session → eliza_mobile_ key ─────────────────────────────────────────

 private void complete(Attempt current, JSONObject session) throws Exception {
  if (Boolean.TRUE.equals(session.opt("mfaRequired"))) {
   JSONObject challenge = session.optJSONObject("mfa");
   String type = challenge == null ? null : challenge.optString("type", null), id = challenge == null ? null : challenge.optString("challengeId", null);
   long expiresAt = challenge == null ? 0 : instant(challenge.opt("expiresAt"));
   if (id == null || id.isEmpty() || id.length() > 256 || !("totp".equals(type) || "sms".equals(type) || "passkey".equals(type))) throw new SignInFailure("unavailable");
   synchronized (lock) {
    if (destroyed || attempt != current || current.cancelled) throw new SignInFailure("cancelled");
    if (current.mfaType != null) throw new SignInFailure("unavailable");
    long deadline = Math.min(current.expiresAt, expiresAt);
    if (deadline <= System.currentTimeMillis()) throw new SignInFailure("expired");
    current.mfaType = type; current.mfaChallenge = id; current.failedVerifies = 0; current.expiresAt = deadline;
    current.busy = false; PluginCall waiting = current.waiting; current.waiting = null;
    // Serialize delivery with cancellation acknowledgement. The bridge queues these replies;
    // no storage or lifecycle callback runs while this attempt lock is held.
    JSObject required = new JSObject().put("status", "mfa").put("method", type).put("expiresAt", current.expiresAt)
     .put("attemptId", current.id).put("environment", current.environment.name);
    if (current.requestId != null) required.put("requestId", current.requestId);
    if (waiting != null) waiting.resolve(required);
    else notifyListeners("signInMfaRequired", required, true);
   }
   return;
  }
  String token = session.optString("token", null), refresh = session.optString("refreshToken", null);
  if (!CloudSignInFlow.validStewardToken(token)) throw new SignInFailure("unavailable");
  CloudSignInEnvironment environment = current.environment;
  try {
   requireAuthorization(current);
   String state = CloudSignInFlow.newState(), verifier = CloudSignInFlow.newVerifier();
   JSONObject binding = new JSONObject().put("clientId", config().clientId).put("environment", environment.name).put("redirectUri", environment.callback());
   Response connected = post(current, "/api/v1/app-auth/connect", new JSONObject(binding.toString()).put("flow", "mobile_pkce").put("state", state)
    .put("codeChallenge", CloudSignInFlow.s256(verifier)).put("codeChallengeMethod", "S256").put("deviceName", config().deviceName), token);
   if (connected.status != 200) throw new SignInFailure(CloudSignInFlow.failureForStatus("connect", connected.status));
   String code = connected.data.optString("code", "");
   if (!"mobile_app_auth_code".equals(connected.data.optString("codeType")) || !code.matches("emac_[0-9a-f]{64}")) throw new SignInFailure("unavailable");
   Object created = connected.data.opt("accountCreated");
   JSONObject proof = new JSONObject(binding.toString()).put("code", code).put("state", state).put("codeVerifier", verifier);
   Response minted = post(current, "/api/v1/app-auth/mobile/token", new JSONObject(proof.toString()).put("grantType", "authorization_code"), null);
   if (minted.status != 200) throw new SignInFailure(CloudSignInFlow.failureForStatus("token", minted.status));
   String secret = minted.data.optString("secret", null), credentialId = minted.data.optString("credentialId", null);
   long expiresAt = instant(minted.data.opt("expiresAt")), acknowledgeBy = instant(minted.data.opt("acknowledgeBy"));
   if (!Boolean.TRUE.equals(minted.data.opt("acknowledgementRequired")) || !"Bearer".equals(minted.data.optString("tokenType"))
    || !CloudSignInFlow.validMobileSecret(secret) || !CloudSignInFlow.validUuid(credentialId) || expiresAt <= System.currentTimeMillis() || acknowledgeBy <= System.currentTimeMillis())
    throw new SignInFailure("unavailable");
   synchronized (lock) { if (current.cancelled || attempt != current) throw new SignInFailure("cancelled"); }
   // Durable receipt first (no secret: the key is read back from its slot), then the key itself.
   CloudCredentialSlots receipts = credentials(() -> {
    if (destroyed || current.cancelled) throw new IllegalStateException("Sign-in closed");
    current.credentialGuard.run();
   });
   receipts.write(config().receiptSlot(environment), new JSONObject(proof.toString()).put("credentialId", credentialId).put("acknowledgeBy", acknowledgeBy).toString());
   // The key this sign-in replaces, if any, is revoked after the acknowledgement of the new one was tried.
   String previous = previousToken(receipts, config().credentialSlot(environment), secret);
   CloudCredentialSlots credentials = credentials(() -> { if (destroyed || current.cancelled) throw new IllegalStateException("Sign-in closed"); current.credentialGuard.run(); });
   JSONObject saved = new JSONObject().put("credentialId", UUID.randomUUID().toString()).put("token", secret).put("expiresAt", expiresAt).put("serverCredentialId", credentialId);
   credentials.write(config().credentialSlot(environment), saved.toString());
   // Commit point: the key is stored. Cancelling now cannot unstore it; activation proceeds.
   storeRenewalRecord(environment, new CloudKeyRenewal.Record(saved.getString("credentialId"), System.currentTimeMillis(), 0, CloudKeyRenewal.Record.NONE));
   CloudSignInFlow.Ack acknowledged = acknowledge(current, proof, credentialId, secret);
   if (acknowledged == CloudSignInFlow.Ack.ACKNOWLEDGED) try { receipts.remove(config().receiptSlot(environment)); } catch (Exception kept) { /* Retried on next start. */ }
   JSObject outcome = new JSObject().put("status", "authenticated").put("environment", environment.name).put("expiresAt", expiresAt)
    .put("attemptId", current.id).put("credentialId", saved.getString("credentialId"))
    .put("accountCreated", created instanceof Boolean ? created : JSONObject.NULL);
   if (current.requestId != null) outcome.put("requestId", current.requestId);
   if (previous != null) {
    // The saved slot no longer holds the replaced key, so revoke it with or without the acknowledgement.
    // One short inline try so completion is not held up; an unconfirmed revocation is retried later.
    boolean revoked = CloudKeyRevocation.revoke(config(), environment, previous);
    if (!revoked) retryRevocation(current.credentialGuard, environment, previous, 0);
    outcome.put("previousSignIn", revoked ? "revoked" : "unconfirmed");
   }
   if (acknowledged != CloudSignInFlow.Ack.ACKNOWLEDGED) {
    // The key is stored but not active. With no answer yet it is asked again in the background
    // until Cloud's deadline (signInCompleted follows); a key Cloud refused can never work.
    if (acknowledged == CloudSignInFlow.Ack.RETRY && System.currentTimeMillis() < acknowledgeBy) {
     synchronized (lock) { activating.add(environment.name); }
     retryAcknowledgement(current.credentialGuard, environment, proof, credentialId, secret, outcome, acknowledgeBy, 0);
     throw new SignInFailure("activation-pending");
    }
    expireActivation(current.credentialGuard, environment, credentialId, secret);
    throw new SignInFailure("activation-expired");
   }
   finish(current, outcome);
  } finally {
   // The Steward session is not needed past this point: revoke it, best effort, never stored.
   try { JSONObject body = new JSONObject(); if (refresh != null && refresh.length() <= 16384) body.put("refreshToken", refresh); post(null, environment, "/steward/auth/logout", body, token); }
   catch (Exception ignored) { /* Best effort; the session expires on its own. */ }
  }
 }
 /** The replaced key is held only in this closure, never stored. Closing the plugin or a newer
  * credential action (sign-in, sign-out, reset) drops the remaining retries. */
 private void retryRevocation(Runnable guard, CloudSignInEnvironment environment, String previous, int round) {
  if (round >= REVOCATION_RETRY_MS.length) return;
  main.postDelayed(() -> run(() -> {
   try { if (destroyed) return; guard.run(); } catch (RuntimeException superseded) { return; }
   if (!CloudKeyRevocation.revoke(config(), environment, previous)) retryRevocation(guard, environment, previous, round + 1);
  }), REVOCATION_RETRY_MS[round]);
 }
 /** The saved key for this environment that the new one replaces, or null when none (or the same key). */
 private static String previousToken(CloudCredentialSlots store, String slot, String issued) {
  try {
   String raw = store.read(slot);
   String token = raw == null ? null : new JSONObject(raw).optString("token", null);
   return token == null || token.isEmpty() || token.equals(issued) ? null : token;
  } catch (Exception unreadable) { return null; }
 }
 /** Bounded retry: ack is idempotent and the key is re-revealed until acknowledgeBy. */
 private CloudSignInFlow.Ack acknowledge(Attempt current, JSONObject proof, String credentialId, String secret) throws Exception {
  CloudSignInEnvironment environment = current == null ? config().environment(proof.getString("environment")) : current.environment;
  for (int round = 0; round < CloudSignInFlow.ACK_ATTEMPTS; round++) {
   if (round > 0) Thread.sleep(CloudSignInFlow.ackBackoffMs(round));
   if (destroyed) return CloudSignInFlow.Ack.RETRY;
   Response acked;
   try { acked = post(null, environment, "/api/v1/app-auth/mobile/ack", new JSONObject(proof.toString()).put("credentialId", credentialId).put("secret", secret), null); }
   catch (SignInFailure transport) { continue; }
   // An answer that does not confirm this credential is not a refusal: it is not repeated here.
   if (acked.status == 200) return "acknowledged".equals(acked.data.optString("status")) && credentialId.equals(acked.data.optString("credentialId")) ? CloudSignInFlow.Ack.ACKNOWLEDGED : CloudSignInFlow.Ack.RETRY;
   if (acked.status == 409 && "authorization_complete".equals(acked.data.optString("error"))) return CloudSignInFlow.Ack.ACKNOWLEDGED;
   if (!CloudSignInFlow.ackRetryable(acked.status)) return CloudSignInFlow.Ack.REFUSED;
  }
  return CloudSignInFlow.Ack.RETRY;
 }
 /**
  * A stored key Cloud has not confirmed is asked again in this process, apart from sign-in work, with
  * a growing delay until Cloud answers; the last request is sent just after `acknowledgeBy`, so a
  * confirmation whose answer was lost is still seen. The proof and the key stay in this closure, never
  * in storage. A newer credential action (sign-in, sign-out, reset) or closing the plugin ends it; the
  * receipt then waits for the next start, which settles it the same way (resumeAcknowledgements).
  */
 private void retryAcknowledgement(Runnable guard, CloudSignInEnvironment environment, JSONObject proof, String credentialId, String secret, JSObject outcome, long acknowledgeBy, int round) {
  long wait = Math.min(CloudSignInFlow.ackRetryDelayMs(round), Math.max(1000L, acknowledgeBy - System.currentTimeMillis() + 1000L));
  main.postDelayed(() -> {
   try {
    recovery.execute(() -> {
     try { if (destroyed) return; guard.run(); }
     catch (RuntimeException superseded) { synchronized (lock) { activating.remove(environment.name); } return; }
     CloudSignInFlow.Ack answer = CloudSignInFlow.Ack.RETRY;
     try {
      Response acked = post(null, environment, "/api/v1/app-auth/mobile/ack", new JSONObject(proof.toString()).put("credentialId", credentialId).put("secret", secret), null);
      if (acked.status == 200 && "acknowledged".equals(acked.data.optString("status")) && credentialId.equals(acked.data.optString("credentialId"))) answer = CloudSignInFlow.Ack.ACKNOWLEDGED;
      else if (acked.status == 409 && "authorization_complete".equals(acked.data.optString("error"))) answer = CloudSignInFlow.Ack.ACKNOWLEDGED;
      else if (acked.status != 200 && !CloudSignInFlow.ackRetryable(acked.status)) answer = CloudSignInFlow.Ack.REFUSED;
     } catch (Exception unanswered) { /* Asked again. */ }
     final CloudSignInFlow.Ack settled = answer;
     if (settled == CloudSignInFlow.Ack.RETRY && System.currentTimeMillis() < acknowledgeBy) { retryAcknowledgement(guard, environment, proof, credentialId, secret, outcome, acknowledgeBy, round + 1); return; }
     run(() -> {
      synchronized (lock) { activating.remove(environment.name); }
      if (settled == CloudSignInFlow.Ack.ACKNOWLEDGED) activated(guard, environment, credentialId, outcome);
      else if (expireActivation(guard, environment, credentialId, secret)) notifyListeners("signInIncomplete", new JSObject().put("code", "activation-expired"), true);
     });
    });
   } catch (java.util.concurrent.RejectedExecutionException closed) { /* Activity teardown: the receipt waits for the next start. */ }
  }, wait);
 }
 /** Cloud confirmed the stored key after its sign-in step had ended: the receipt goes and the sign-in
  * is announced once, only while that same key is still the saved one. */
 private void activated(Runnable guard, CloudSignInEnvironment environment, String credentialId, JSObject outcome) {
  try {
   CloudCredentialSlots owned = credentials(() -> { if (destroyed) throw new IllegalStateException("Sign-in closed"); guard.run(); });
   String slot = config().receiptSlot(environment), receipt = owned.read(slot);
   if (receipt != null && credentialId.equals(new JSONObject(receipt).optString("credentialId"))) owned.remove(slot);
  } catch (Exception kept) { /* Retried on the next start. */ }
  synchronized (lock) {
   if (destroyed) return;
   try {
    withCredentialRead(() -> {
     guard.run();
     String saved = credentials(guard).read(config().credentialSlot(environment));
     if (saved == null || !outcome.getString("credentialId").equals(new JSONObject(saved).optString("credentialId", null)))
      throw new IllegalStateException("Saved sign-in changed");
     JSObject delivered = outcome;
     if (!outcome.has("requestId")) {
      delivered = new JSObject().put("status", "authenticated").put("environment", environment.name)
       .put("expiresAt", outcome.opt("expiresAt")).put("accountCreated", outcome.opt("accountCreated"));
      if (outcome.has("previousSignIn")) delivered.put("previousSignIn", outcome.opt("previousSignIn"));
     }
     notifyListeners("signInCompleted", delivered, true);
     return null;
    });
   } catch (Exception superseded) { /* A newer credential action owns the saved sign-in: nothing is announced. */ }
  }
 }
 /**
  * Cloud refused the stored key's acknowledgement, or did not confirm it by its deadline: the key
  * can never work. It and its receipt are removed, only while this sign-in still owns them (its
  * credential intent and the exact stored key), and the key is revoked best effort in case a
  * confirmation was lost. False when a newer credential action owns the slot: nothing is removed.
  */
 private boolean expireActivation(Runnable guard, CloudSignInEnvironment environment, String credentialId, String secret) {
  try {
   CloudCredentialSlots owned = credentials(() -> { if (destroyed) throw new IllegalStateException("Sign-in closed"); guard.run(); });
   String slot = config().credentialSlot(environment), saved = owned.read(slot);
   if (saved != null && credentialId.equals(new JSONObject(saved).optString("serverCredentialId")) && !owned.compareExchange(slot, saved, null)) return false;
   String receiptSlot = config().receiptSlot(environment), receipt = owned.read(receiptSlot);
   if (receipt != null && credentialId.equals(new JSONObject(receipt).optString("credentialId"))) owned.remove(receiptSlot);
  } catch (Exception superseded) { return false; }
  CloudKeyRevocation.revoke(config(), environment, secret);
  return true;
 }
 /**
  * A key stored before an interrupted ack is settled on the next start, with the outcomes of the
  * in-process path. While Cloud's deadline has not passed it is acknowledged at once and, with no
  * answer, asked again in the background (retryAcknowledgement). After the deadline one request tells
  * a confirmation whose answer was lost from a key that never became active. A confirmed key keeps
  * its slot, loses its receipt and is announced (`signInCompleted`); a key Cloud refused or never
  * confirmed is removed with its receipt, only while it is still the exact saved key, revoked best
  * effort and reported (`signInIncomplete`, `activation-expired`). Until then status() reports
  * `activationPending`.
  *
  * The sign-in worker reads the receipt. The requests run apart from it, so a slow request never
  * delays a sign-in step. A receipt that names no saved key is stale and goes; a receipt that a newer
  * sign-in wrote stays. No interactive attempt exists here and none is created: the removal is bound
  * to the host's newest credential intent when the host can observe it, and always to the exact key.
  */
 private void resumeAcknowledgements() {
  for (CloudSignInEnvironment environment : config().environments()) {
   try {
    // Observed before the read: a credential action reserved afterwards ends this recovery.
    Runnable observed = null;
    try { observed = observeCredentialCommit(); } catch (RuntimeException unavailable) { /* Bound to the exact key only. */ }
    final Runnable guard = observed != null ? observed : () -> {};
    CloudCredentialSlots store = store();
    String slot = config().receiptSlot(environment), raw = store.read(slot);
    if (raw == null) continue;
    JSONObject receipt = new JSONObject(raw), proof = new JSONObject();
    // A renewal keeps the predecessor selected; its successor secret is in this encrypted receipt.
    if (CloudKeyRenewal.Receipt.isRenewal(receipt) || CloudKeyRenewal.Request.isRequest(receipt)) { renew(environment, null); continue; }
    for (String key : new String[]{"clientId", "environment", "redirectUri", "code", "state", "codeVerifier"}) proof.put(key, receipt.getString(key));
    String credentialId = receipt.getString("credentialId"), saved = store.read(config().credentialSlot(environment));
    JSONObject credential = saved == null ? null : new JSONObject(saved);
    boolean current = credential != null && credentialId.equals(credential.optString("serverCredentialId")) && environment.name.equals(proof.getString("environment"));
    if (!current) { credentials(guard).compareExchange(slot, raw, null); continue; }
    final long acknowledgeBy = receipt.getLong("acknowledgeBy");
    final String token = credential.getString("token");
    // The unscoped outcome: no caller waits, and whether the account was created is no longer known.
    final JSObject outcome = new JSObject().put("status", "authenticated").put("environment", environment.name)
     .put("expiresAt", instant(credential.opt("expiresAt"))).put("credentialId", credential.optString("credentialId", "")).put("accountCreated", JSONObject.NULL);
    synchronized (lock) { activating.add(environment.name); }
    recovery.execute(() -> {
     // Past the deadline: the single request just after it, on the in-process schedule, then the key is settled.
     if (System.currentTimeMillis() >= acknowledgeBy) { retryAcknowledgement(guard, environment, proof, credentialId, token, outcome, acknowledgeBy, 0); return; }
     CloudSignInFlow.Ack answer = CloudSignInFlow.Ack.RETRY;
     try { answer = acknowledge(null, proof, credentialId, token); } catch (Exception unanswered) { /* Asked again below. */ }
     // A closed plugin settles nothing: the receipt waits for the next start.
     if (destroyed) return;
     if (answer == CloudSignInFlow.Ack.RETRY) { retryAcknowledgement(guard, environment, proof, credentialId, token, outcome, acknowledgeBy, 0); return; }
     final CloudSignInFlow.Ack settled = answer;
     run(() -> {
      synchronized (lock) { activating.remove(environment.name); }
      try { guard.run(); } catch (RuntimeException superseded) { return; }
      if (settled == CloudSignInFlow.Ack.ACKNOWLEDGED) activated(guard, environment, credentialId, outcome);
      else if (expireActivation(guard, environment, credentialId, token)) notifyListeners("signInIncomplete", new JSObject().put("code", "activation-expired"), true);
     });
    });
   } catch (Exception unavailable) { /* Kept for the next start. */ }
  }
 }

 // ── Silent key renewal ───────────────────────────────────────────────────────────────────────

 /** One renewal check of a deployment's saved key. Guarded by lock. */
 private static final class Renewal {
  final List<PluginCall> waiting = new ArrayList<>();
  /** Set once the callers were answered; a check that still awaits Cloud's confirmation keeps it for later callers. */
  JSObject answer;
 }
 private final Map<String, Renewal> renewing = new HashMap<>();
 /** The automatic check (load, resume) reads storage at most once an hour in a process. */
 private static final long RENEWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000L;
 private long renewalCheckedAt;

 /**
  * Renews the saved key of a deployment when it is due and reports where it stands:
  * `{environment, status, expiryWarning, expiresAt?, credentialId?}`, never a key. `status` is
  * `current` (not due), `renewed`, `deferred` (due, but a sign-in is in progress, the daily request
  * was used, Cloud could not answer or the saved key still awaits its acknowledgement),
  * `sign-in-required` (Cloud will not renew this key), `unavailable` (the host cannot renew in the
  * background) or `signed-out` (no usable saved key). `expiryWarning` is true only with fewer than
  * three days left and no renewal that can help. A refusal never removes the working key.
  * `keyRefused: true` accompanies `sign-in-required` when Cloud answered the renewal request with 401:
  * Cloud no longer accepts the saved key at all, so it has no days left and `expiryWarning` is true.
  */
 @PluginMethod public void renewSignIn(PluginCall call) {
  final CloudSignInEnvironment environment;
  try { String name = call.getString("environment"); environment = name == null ? config().defaultEnvironment() : config().environment(name); }
  catch (Exception invalid) { call.reject("Unsupported Cloud environment", "invalid-request"); return; }
  renew(environment, call);
 }
 /** The automatic check on load and resume, for every admitted deployment. */
 private void renewSaved() {
  synchronized (lock) {
   long now = System.currentTimeMillis();
   if (destroyed || renewalCheckedAt > 0 && now >= renewalCheckedAt && now - renewalCheckedAt < RENEWAL_CHECK_INTERVAL_MS) return;
   renewalCheckedAt = now;
  }
  // First, on the same worker: a key an earlier renewal replaced and Cloud has not confirmed revoked.
  retireStored();
  for (CloudSignInEnvironment environment : config().environments()) renew(environment, null);
 }
 /** One check per deployment at a time, apart from sign-in work; concurrent callers join it. */
 private void renew(CloudSignInEnvironment environment, PluginCall call) {
  final Renewal current;
  synchronized (lock) {
   if (destroyed) { if (call != null) call.reject("Sign-in closed", "unavailable"); return; }
   Renewal running = renewing.get(environment.name);
   if (running != null) {
    if (call == null) return;
    if (running.answer != null) call.resolve(running.answer); else running.waiting.add(call);
    return;
   }
   current = new Renewal(); if (call != null) current.waiting.add(call); renewing.put(environment.name, current);
  }
  final boolean explicit = call != null;
  try {
   renewer.execute(() -> {
    JSObject outcome;
    try { outcome = renewNow(environment, current, explicit); }
    catch (Exception unavailable) { outcome = renewalOutcome(environment, "deferred", 0, false); }
    if (outcome != null) renewalAnswered(environment, current, outcome, true);
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { renewalAnswered(environment, current, renewalOutcome(environment, "deferred", 0, false), true); }
 }
 private static JSObject renewalOutcome(CloudSignInEnvironment environment, String status, long expiresAt, boolean warning) {
  JSObject outcome = new JSObject().put("environment", environment.name).put("status", status).put("expiryWarning", warning);
  if (expiresAt > 0) outcome.put("expiresAt", expiresAt);
  return outcome;
 }
 /** `sign-in-required`. A key Cloud refused outright (401) is reported as such and warns at once: it has no days left. */
 private static JSObject renewalRefused(CloudSignInEnvironment environment, long now, long expiresAt, boolean keyRefused) {
  JSObject outcome = renewalOutcome(environment, "sign-in-required", expiresAt, keyRefused || CloudKeyRenewal.warn(now, expiresAt, true));
  if (keyRefused) outcome.put("keyRefused", true);
  return outcome;
 }
 /** Answers the callers of this check. `ended` also frees the deployment for the next check. */
 private void renewalAnswered(CloudSignInEnvironment environment, Renewal current, JSObject outcome, boolean ended) {
  List<PluginCall> answered;
  final JSObject delivered;
  synchronized (lock) {
   if (outcome != null) current.answer = outcome;
   delivered = current.answer;
   answered = new ArrayList<>(current.waiting); current.waiting.clear();
   if (ended && renewing.get(environment.name) == current) renewing.remove(environment.name);
  }
  for (PluginCall waiting : answered) waiting.resolve(delivered);
 }
 /** No sign-in is in progress, the plugin is open and no credential action was reserved since the renewal read the saved key. Takes no lock: it also runs as a store guard. */
 private boolean renewalCurrent(Runnable observed) {
  if (destroyed || attempt != null) return false;
  try { observed.run(); return true; } catch (RuntimeException superseded) { return false; }
 }
 /** Exact native-slot CAS with readback also resolves a lost local write acknowledgement. */
 private boolean renewalCompare(CloudCredentialSlots owned, String slot, String expected, String replacement) throws Exception {
  try { owned.compareExchange(slot, expected, replacement); }
  catch (Exception uncertain) { /* Read back under the same intent before making any claim. */ }
  return java.util.Objects.equals(owned.read(slot), replacement);
 }
 /** The original durable generation, never the newest generation at recovery time. */
 private Runnable renewalReceiptGuard(CloudKeyRenewal.Receipt receipt) {
  final Runnable adopted;
  try { adopted = adoptCredentialCommit(receipt.generation); }
  catch (RuntimeException unavailable) { return null; }
  if (adopted == null) return null;
  return () -> { if (!renewalCurrent(adopted)) throw new IllegalStateException("Renewal superseded"); };
 }
 /** The exact ACK is the server's receipt; an exchange-state 409 is not an activation receipt. */
 private CloudSignInFlow.Ack acknowledgeRenewal(Runnable observed, CloudSignInEnvironment environment, CloudKeyRenewal.Receipt receipt) throws Exception {
  int attempts = System.currentTimeMillis() >= receipt.acknowledgeBy ? 1 : CloudSignInFlow.ACK_ATTEMPTS;
  for (int round = 0; round < attempts; round++) {
   if (round > 0) Thread.sleep(CloudSignInFlow.ackBackoffMs(round));
   if (!renewalCurrent(observed) || !receipt.raw.equals(credentials(observed).read(config().receiptSlot(environment)))) return CloudSignInFlow.Ack.RETRY;
   Response acked;
   try { acked = post(null, environment, "/api/v1/app-auth/mobile/ack", receipt.proof(), null); }
   catch (SignInFailure transport) { continue; }
   if (acked.status == 200) return "acknowledged".equals(acked.data.optString("status")) && receipt.credentialId.equals(acked.data.optString("credentialId"))
    ? CloudSignInFlow.Ack.ACKNOWLEDGED : CloudSignInFlow.Ack.RETRY;
   if (acked.status == 409 && "authorization_complete".equals(acked.data.optString("error"))) return CloudSignInFlow.Ack.RETRY;
   if (!CloudSignInFlow.ackRetryable(acked.status)) return CloudSignInFlow.Ack.REFUSED;
  }
  return CloudSignInFlow.Ack.RETRY;
 }
 /**
  * The existing encrypted receipt is authoritative, even after its ACK deadline. A landed ACK can
  * be replayed after that deadline; an unanswered ACK never makes its successor safe to forget.
  */
 private JSObject recoverRenewal(CloudSignInEnvironment environment, Renewal current, CloudKeyRenewal.Receipt receipt) throws Exception {
  Runnable observed = renewalReceiptGuard(receipt);
  if (observed == null) return renewalOutcome(environment, "unavailable", receipt.previousExpiresAt, CloudKeyRenewal.warn(System.currentTimeMillis(), receipt.previousExpiresAt, true));
  final JSObject failed = renewalOutcome(environment, "deferred", receipt.previousExpiresAt, CloudKeyRenewal.warn(System.currentTimeMillis(), receipt.previousExpiresAt, true));
  if (!renewalCurrent(observed)) return failed;
  CloudCredentialSlots owned = credentials(observed);
  if (!receipt.raw.equals(owned.read(config().receiptSlot(environment)))) return failed;
  String selected = owned.read(config().credentialSlot(environment));
  if (!receipt.matchesPredecessor(selected) && !receipt.matchesSuccessor(selected) && !(receipt.confirmed && selected == null)) return failed;
  if (receipt.expiresAt <= System.currentTimeMillis()) return renewalOutcome(environment, "signed-out", 0, false);
  if (receipt.confirmed) return renewalSettled(observed, environment, receipt, CloudSignInFlow.Ack.ACKNOWLEDGED);
  CloudSignInFlow.Ack answer = acknowledgeRenewal(observed, environment, receipt);
  if (answer == CloudSignInFlow.Ack.RETRY && System.currentTimeMillis() < receipt.acknowledgeBy) {
   renewalAnswered(environment, current, renewalOutcome(environment, "deferred", receipt.previousExpiresAt, false), false);
   renewalAcknowledgement(observed, environment, current, receipt, 0);
   return null;
  }
  return renewalSettled(observed, environment, receipt, answer);
 }
 /**
  * A fresh renewal requires a restart-adoptable durable credential generation before network work.
  * The selected key remains unchanged while a successor secret and PKCE proof are committed and
  * read back from the existing encrypted receipt slot, before the first ACK can erase Cloud's copy.
  */
 private JSObject renewNow(CloudSignInEnvironment environment, Renewal current, boolean explicit) throws Exception {
  final String slot = config().credentialSlot(environment);
  final Runnable[] observation = new Runnable[1];
  final String[] read = new String[4];
  withCredentialRead(() -> {
   observation[0] = observeCredentialCommit();
   CloudCredentialSlots slots = store();
   read[0] = slots.read(slot); read[1] = slots.read(config().receiptSlot(environment));
   read[2] = slots.read(config().pendingSlot); read[3] = credentialGeneration();
   return null;
  });
  // A renewal receipt does not name the selected predecessor as an interactive ACK would.
  if (read[1] != null && CloudKeyRenewal.Receipt.isRenewal(new JSONObject(read[1])))
   return recoverRenewal(environment, current, CloudKeyRenewal.Receipt.parse(read[1], config(), environment));
  final Runnable observed = observation[0];
  if (observed == null && !explicit) return renewalOutcome(environment, "unavailable", 0, false);
  JSONObject credential = read[0] == null ? null : new JSONObject(read[0]);
  final String previous = credential == null ? null : credential.optString("token", null), localId = credential == null ? null : credential.optString("credentialId", null);
  final long now = System.currentTimeMillis(), expiresAt = credential == null ? 0 : instant(credential.opt("expiresAt"));
  if (!CloudSignInFlow.validMobileSecret(previous) || expiresAt <= now) return renewalOutcome(environment, "signed-out", 0, false);
  boolean unconfirmed;
  synchronized (lock) { unconfirmed = activating.contains(environment.name); }
  if (read[1] != null && CloudKeyRenewal.Request.isRequest(new JSONObject(read[1]))) {
   CloudKeyRenewal.Request pending = CloudKeyRenewal.Request.parse(read[1], config(), environment);
   // The owner may still be live, paused just before /renew. Never free this claim by time alone.
   if (pending.matchesPredecessor(read[0])) {
    CloudKeyRenewal.Record known = CloudKeyRenewal.Record.of(renewalRecord(environment), localId);
    if (known.signInRequired()) return renewalRefused(environment, now, expiresAt, CloudKeyRenewal.Record.REJECTED.equals(known.result));
    if (now >= pending.attemptedAt && now - pending.attemptedAt >= CloudKeyRenewal.MIN_INTERVAL_MS)
     return renewalRefused(environment, now, expiresAt, false);
   }
   CloudKeyRenewal.Record known = CloudKeyRenewal.Record.of(renewalRecord(environment), localId);
   return renewalOutcome(environment, "deferred", expiresAt, CloudKeyRenewal.warn(now, expiresAt, known.failed()));
  }
  if (read[1] != null || unconfirmed) return renewalOutcome(environment, "deferred", expiresAt, false);
  if (!CloudSignInFlow.validUuid(localId)) return renewalOutcome(environment, "unavailable", expiresAt, CloudKeyRenewal.warn(now, expiresAt, true));
  final CloudKeyRenewal.Record record = CloudKeyRenewal.Record.of(renewalRecord(environment), localId);
  if (!CloudKeyRenewal.due(now, record.issuedAt, expiresAt)) return renewalOutcome(environment, "current", expiresAt, false);
  final String generation = read[3];
  Runnable adopted = CloudSignInFlow.Pending.validGeneration(generation) ? adoptCredentialCommit(generation) : null;
  if (observed == null || adopted == null) return renewalOutcome(environment, "unavailable", expiresAt, CloudKeyRenewal.warn(now, expiresAt, true));
  final Runnable durableGuard = () -> { observed.run(); adopted.run(); };
  boolean active;
  synchronized (lock) { active = attempt != null; }
  if (!active && read[2] != null) {
   CloudSignInFlow.Pending inBrowser = CloudSignInFlow.Pending.parse(read[2], config());
   active = inBrowser != null && !inBrowser.expired(now);
  }
  if (active || !renewalCurrent(durableGuard)) return renewalOutcome(environment, "deferred", expiresAt, CloudKeyRenewal.warn(now, expiresAt, record.failed()));
  if (record.spent()) return renewalRefused(environment, now, expiresAt, false);
  if (!CloudKeyRenewal.allowed(now, record.attemptedAt))
   return record.signInRequired() ? renewalRefused(environment, now, expiresAt, CloudKeyRenewal.Record.REJECTED.equals(record.result))
    : renewalOutcome(environment, "deferred", expiresAt, CloudKeyRenewal.warn(now, expiresAt, record.failed()));
  final CloudKeyRenewal.Record asked = record.attempted(now, CloudKeyRenewal.Record.RETRY);
  final JSObject failed = renewalOutcome(environment, "deferred", expiresAt, CloudKeyRenewal.warn(now, expiresAt, true));
  CloudCredentialSlots owned = credentials(() -> { if (!renewalCurrent(durableGuard)) throw new IllegalStateException("Renewal superseded"); });
  final String receiptSlot = config().receiptSlot(environment);
  CloudKeyRenewal.Request request = CloudKeyRenewal.Request.create(config(), environment, generation, read[0], now);
  if (!renewalCompare(owned, receiptSlot, null, request.raw)) return failed;
  boolean dispatched = false;
  try {
   // Re-read durable bookkeeping only after the exclusive claim. A stale per-instance cache must
   // not bypass the daily limit after another owner completed an unsuccessful request.
   CloudKeyRenewal.Record latest = CloudKeyRenewal.Record.of(renewalRecord(environment), localId);
   if (latest.spent()) return renewalRefused(environment, now, expiresAt, false);
   if (!CloudKeyRenewal.allowed(now, latest.attemptedAt))
    return latest.signInRequired() ? renewalRefused(environment, now, expiresAt, CloudKeyRenewal.Record.REJECTED.equals(latest.result)) : failed;
   if (!storeRenewalRecord(environment, asked)) return failed;
   // A different instance may have fully published between our initial read and claim. Both the
   // selected predecessor and exact claim must still match immediately before dispatch.
   if (!request.matchesPredecessor(owned.read(slot)) || !request.raw.equals(owned.read(receiptSlot)) || !renewalCurrent(durableGuard)) return failed;
   String state = CloudSignInFlow.newState(), verifier = CloudSignInFlow.newVerifier();
   Response renewed;
   dispatched = true;
   try { renewed = post(null, environment, CloudKeyRenewal.PATH, CloudKeyRenewal.body(config(), environment, state, CloudSignInFlow.s256(verifier)), previous); }
   catch (SignInFailure unanswered) { return failed; }
   CloudKeyRenewal.Answer answer = CloudKeyRenewal.answer(renewed.status);
   if (answer == CloudKeyRenewal.Answer.SIGN_IN_REQUIRED) {
    boolean keyRefused = CloudKeyRenewal.keyRefused(renewed.status);
    storeRenewalRecord(environment, asked.attempted(now, keyRefused ? CloudKeyRenewal.Record.REJECTED : CloudKeyRenewal.Record.REFUSED));
    return renewalRefused(environment, now, expiresAt, keyRefused);
   }
   String code = renewed.data.optString("code", "");
   if (answer != CloudKeyRenewal.Answer.CODE || !Boolean.TRUE.equals(renewed.data.opt("success")) || !code.matches("emac_[0-9a-f]{64}")
    || renewed.data.has("codeType") && !"mobile_app_auth_code".equals(renewed.data.optString("codeType"))) return failed;
   JSONObject proof = new JSONObject().put("clientId", config().clientId).put("environment", environment.name).put("redirectUri", environment.callback())
    .put("code", code).put("state", state).put("codeVerifier", verifier);
   Response minted;
   if (!renewalCurrent(durableGuard) || !request.raw.equals(owned.read(receiptSlot))) return failed;
   try { minted = post(null, environment, "/api/v1/app-auth/mobile/token", new JSONObject(proof.toString()).put("grantType", "authorization_code"), null); }
   catch (SignInFailure unanswered) { return failed; }
   if (minted.status != 200) return failed;
   String secret = minted.data.optString("secret", null), credentialId = minted.data.optString("credentialId", null);
   long renewedUntil = instant(minted.data.opt("expiresAt")), acknowledgeBy = instant(minted.data.opt("acknowledgeBy"));
   if (!Boolean.TRUE.equals(minted.data.opt("acknowledgementRequired")) || !"Bearer".equals(minted.data.optString("tokenType"))
    || !CloudSignInFlow.validMobileSecret(secret) || secret.equals(previous) || !CloudSignInFlow.validUuid(credentialId)
    || renewedUntil <= expiresAt || acknowledgeBy <= System.currentTimeMillis() || !renewalCurrent(durableGuard)) return failed;
   CloudKeyRenewal.Receipt receipt = CloudKeyRenewal.Receipt.create(config(), environment, generation, read[0], proof, credentialId, secret, renewedUntil, acknowledgeBy);
   if (!receipt.matchesPredecessor(owned.read(slot)) || !renewalCompare(owned, receiptSlot, request.raw, receipt.raw)) return failed;
   // Critical custody is now the encrypted receipt. This advisory marker is not its durability barrier.
   storeRenewalRecord(environment, asked.attempted(now, CloudKeyRenewal.Record.CONFIRMING));
   return recoverRenewal(environment, current, receipt);
  } finally {
   // Once dispatched, server work may outlive even a failed local request. Retain the claim until
   // it advances to a full secret receipt or an interactive sign-in replaces it. Only a claim whose
   // owner sent no request can be removed here; exact CAS cannot erase a newer owner's record.
   if (!dispatched) try { owned.compareExchange(receiptSlot, request.raw, null); } catch (Exception retained) { /* Kept for explicit sign-in recovery. */ }
  }
 }
 /** Retry exactly the durably staged proof; passing its deadline never discards the receipt. */
 private void renewalAcknowledgement(Runnable observed, CloudSignInEnvironment environment, Renewal current, CloudKeyRenewal.Receipt receipt, int round) {
  long wait = Math.min(CloudSignInFlow.ackRetryDelayMs(round), Math.max(1000L, receipt.acknowledgeBy - System.currentTimeMillis() + 1000L));
  main.postDelayed(() -> {
   try {
    renewer.execute(() -> {
     if (!renewalCurrent(observed)) { renewalAnswered(environment, current, null, true); return; }
     try {
      CloudCredentialSlots owned = credentials(observed);
      if (!receipt.raw.equals(owned.read(config().receiptSlot(environment)))) { renewalAnswered(environment, current, null, true); return; }
      CloudSignInFlow.Ack answer = acknowledgeRenewal(observed, environment, receipt);
      if (answer == CloudSignInFlow.Ack.RETRY && System.currentTimeMillis() < receipt.acknowledgeBy) { renewalAcknowledgement(observed, environment, current, receipt, round + 1); return; }
      renewalAnswered(environment, current, renewalSettled(observed, environment, receipt, answer), true);
     } catch (Exception unavailable) { renewalAnswered(environment, current, renewalOutcome(environment, "deferred", receipt.previousExpiresAt, false), true); }
    });
   } catch (java.util.concurrent.RejectedExecutionException closed) { /* The encrypted receipt waits for restart. */ }
  }, wait);
 }
 /** Publish only a confirmed, durably recoverable successor under its original credential intent. */
 private JSObject renewalSettled(Runnable observed, CloudSignInEnvironment environment, CloudKeyRenewal.Receipt receipt, CloudSignInFlow.Ack acknowledged) {
  final JSObject failed = renewalOutcome(environment, "deferred", receipt.previousExpiresAt, CloudKeyRenewal.warn(System.currentTimeMillis(), receipt.previousExpiresAt, true));
  if (!renewalCurrent(observed)) return failed;
  try {
   CloudCredentialSlots owned = credentials(observed);
   String receiptSlot = config().receiptSlot(environment);
   if (!receipt.raw.equals(owned.read(receiptSlot))) return failed;
   if (acknowledged != CloudSignInFlow.Ack.ACKNOWLEDGED) {
    // Even a refusal does not prove that an earlier exact in-flight ACK cannot still commit.
    // Keep custody and never present this predecessor to /renew again.
    return acknowledged == CloudSignInFlow.Ack.REFUSED
     ? renewalRefused(environment, System.currentTimeMillis(), receipt.previousExpiresAt, false) : failed;
   }
   if (!receipt.confirmed) {
    String confirmed = receipt.confirmedRecord();
    if (!renewalCompare(owned, receiptSlot, receipt.raw, confirmed)) return failed;
    receipt = CloudKeyRenewal.Receipt.parse(confirmed, config(), environment);
   }
   String slot = config().credentialSlot(environment), selected = owned.read(slot);
   if (!receipt.matchesPredecessor(selected) && !receipt.matchesSuccessor(selected) && selected != null) return failed;
   String retiring = config().retiringSlot(environment);
   String duty = new JSONObject().put("token", receipt.previousToken).put("expiresAt", receipt.previousExpiresAt).put("successor", receipt.credentialId).toString();
   String previousDuty = owned.read(retiring);
   if (previousDuty != null) {
    JSONObject storedDuty = new JSONObject(previousDuty);
    if (!receipt.previousToken.equals(storedDuty.optString("token", null)) || receipt.previousExpiresAt != instant(storedDuty.opt("expiresAt"))
      || !receipt.credentialId.equals(storedDuty.optString("successor", null))) return failed;
    duty = previousDuty;
   }
   if (!renewalCompare(owned, retiring, previousDuty, duty)) return failed;
   if (!receipt.matchesSuccessor(selected)) {
    try { owned.compareExchange(slot, selected, receipt.successor); }
    catch (Exception uncertain) { /* A partial host publication is repaired from this confirmed receipt. */ }
    if (!receipt.matchesSuccessor(owned.read(slot))) return failed;
   }
   // The successor is durably selected; its receipt can now be retired by exact identity only.
   try { renewalCompare(owned, receiptSlot, receipt.raw, null); }
   catch (Exception kept) { /* Selection is confirmed; a retained receipt is safe to retry. */ }
   storeRenewalRecord(environment, new CloudKeyRenewal.Record(receipt.installedId, System.currentTimeMillis(), 0, CloudKeyRenewal.Record.NONE));
   if (!renewalCurrent(observed)) return failed;
   try { savedKeyRenewed(environment, receipt.installedId); } catch (Exception hostFailure) { /* The retained event also asks the renderer to re-admit it. */ }
   if (!renewalCurrent(observed)) return failed;
   if (!retireReplaced(environment, receipt.previousToken, receipt.credentialId)) retryRetirement(environment, receipt.previousToken, receipt.credentialId, 0);
   notifyListeners("signInRenewed", new JSObject().put("environment", environment.name).put("expiresAt", receipt.expiresAt).put("credentialId", receipt.installedId), true);
   return renewalOutcome(environment, "renewed", receipt.expiresAt, false).put("credentialId", receipt.installedId);
  } catch (Exception unavailable) { return failed; }
 }
 /**
  * Makes sure a key a renewal replaced is unusable (2xx, or 401: Cloud already refuses it) and then
  * forgets the stored duty. The request names the key it was renewed into (`successor`, the server
  * credential id), so Cloud revokes the replaced key alone. False when Cloud did not answer: the duty stays.
  */
 private boolean retireReplaced(CloudSignInEnvironment environment, String replaced, String successor) {
  if (!CloudKeyRevocation.retire(config(), environment, replaced, successor)) return false;
  try {
   CloudCredentialSlots slots = store();
   String retiring = config().retiringSlot(environment), duty = slots.read(retiring);
   if (duty != null && replaced.equals(new JSONObject(duty).optString("token", null))
     && successor.equals(new JSONObject(duty).optString("successor", null))) slots.compareExchange(retiring, duty, null);
  } catch (Exception kept) { /* Asked again on a later start; Cloud then answers 401 and the duty goes. */ }
  return true;
 }
 /** Two more tries in this process, on the renewal worker. Unlike a sign-in's replaced key, the duty is also stored. */
 private void retryRetirement(CloudSignInEnvironment environment, String replaced, String successor, int round) {
  if (round >= REVOCATION_RETRY_MS.length) return;
  main.postDelayed(() -> {
   try {
    renewer.execute(() -> { if (!destroyed && !retireReplaced(environment, replaced, successor)) retryRetirement(environment, replaced, successor, round + 1); });
   } catch (java.util.concurrent.RejectedExecutionException closed) { /* The stored duty waits for the next start. */ }
  }, REVOCATION_RETRY_MS[round]);
 }
 /**
  * Stored duties to revoke a key a renewal replaced, tried again on load and with the hourly check, on
  * the renewal worker and ahead of any renewal. A duty for a key that is still the saved one (the
  * renewal ended before its save), that has expired, or that does not name the key it was renewed
  * into is dropped without a request: the saved, working key is never revoked here, and a request
  * that names no successor would end the renewed key with the replaced one.
  */
 private void retireStored() {
  try {
   renewer.execute(() -> {
    for (CloudSignInEnvironment environment : config().environments()) {
     try {
      if (destroyed) return;
      CloudCredentialSlots slots = store();
      String retiring = config().retiringSlot(environment), duty = slots.read(retiring);
      if (duty == null) continue;
      JSONObject stored = new JSONObject(duty);
      String replaced = stored.optString("token", null), successor = CloudKeyRevocation.renewedCredential(stored.optString("successor", null)), saved = slots.read(config().credentialSlot(environment));
      String receiptRaw = slots.read(config().receiptSlot(environment));
      if (receiptRaw != null && CloudKeyRenewal.Receipt.isRenewal(new JSONObject(receiptRaw))) {
       CloudKeyRenewal.Receipt receipt = CloudKeyRenewal.Receipt.parse(receiptRaw, config(), environment);
       // The duty can precede an interrupted selected-key write. Repair publication first.
       if (replaced != null && replaced.equals(receipt.previousToken) && !receipt.matchesSuccessor(saved)) continue;
      }
      boolean stillSaved = saved != null && replaced != null && replaced.equals(new JSONObject(saved).optString("token", null));
      if (stillSaved || successor == null || !CloudSignInFlow.validMobileSecret(replaced) || instant(stored.opt("expiresAt")) <= System.currentTimeMillis()) { slots.compareExchange(retiring, duty, null); continue; }
      retireReplaced(environment, replaced, successor);
     } catch (Exception unavailable) { /* Kept for a later check. */ }
    }
   });
  } catch (java.util.concurrent.RejectedExecutionException closed) { /* Activity teardown. */ }
 }

 // ── Outcomes and transport ───────────────────────────────────────────────────────────────────

 private void finish(Attempt current, JSObject outcome) {
  synchronized (lock) {
   // A committed key may still need its acknowledgement, but a cancelled, destroyed or
   // replaced interaction cannot deliver its completion to a newer renderer owner.
   if (destroyed || current.cancelled || attempt != current) return;
   try {
    // P → lifecycle → vault: a newer intent cannot slip between identity readback and
    // bridge queueing. No credential writer enters P while holding either host lock.
    withCredentialRead(() -> {
     current.credentialGuard.run();
     String saved = credentials(current.credentialGuard).read(config().credentialSlot(current.environment));
     if (saved == null || !outcome.getString("credentialId").equals(new JSONObject(saved).optString("credentialId", null)))
      throw new IllegalStateException("Saved sign-in changed");
     // Older renderers have a strict four-field parser and supplied no request ID.
     JSObject delivered = outcome;
     if (current.requestId == null) {
      delivered = new JSObject().put("status", "authenticated").put("environment", current.environment.name)
       .put("expiresAt", outcome.opt("expiresAt")).put("accountCreated", outcome.opt("accountCreated"));
      if (outcome.has("previousSignIn")) delivered.put("previousSignIn", outcome.opt("previousSignIn"));
     }
     PluginCall waiting = current.waiting; current.waiting = null; attempt = null;
     if (waiting != null) waiting.resolve(delivered);
     else notifyListeners("signInCompleted", delivered, true);
     return null;
    });
   } catch (Exception superseded) {
    // The committed value may have been replaced. Never announce that replacement
    // as the result of this interaction and never remove the successor's data.
    PluginCall waiting = current.waiting; current.waiting = null; attempt = null;
    if (waiting != null) waiting.reject("Saved sign-in changed", "state-mismatch");
   }
  }
 }
 /** Ends the attempt with a stable code. `burn` also removes a pending Google record (explicit cancel or a failed start). */
 private void end(Attempt current, String code, boolean burn) {
  PluginCall waiting;
  synchronized (lock) { current.cancel(); waiting = current.waiting; current.waiting = null; if (attempt == current) { attempt = null; if (current.google && burn) pendingRetirementUnconfirmed = true; } }
  if (current.google && burn) burnUnclaimedPending(current);
  refused(current.environment, code);
  if (waiting != null) waiting.reject(code, code);
  // No call waits for an adopted return: its failure is reported once, retained.
  else if (current.adopted && !"cancelled".equals(code)) notifyListeners("signInIncomplete", new JSObject().put("code", code), true);
 }
 /** Cloud refusing the in-app sign-in invalidates the cached readiness, so the next sign-in re-checks it. */
 private void refused(CloudSignInEnvironment environment, String code) {
  if ("rejected".equals(code) || "invalid-request".equals(code)) forgetReadiness(environment);
 }
 private static long instant(Object value) {
  if (value instanceof Number) return ((Number) value).longValue();
  if (!(value instanceof String)) return 0;
  try { return Instant.parse((String) value).toEpochMilli(); } catch (Exception invalid) { return 0; }
 }
 private Response post(Attempt current, String path, JSONObject body, String bearer) throws Exception {
  return post(current, current.environment, path, body, bearer);
 }
 /** Fixed sign-in routes only; no redirects, bounded bodies, nothing logged. */
 private Response post(Attempt current, CloudSignInEnvironment environment, String path, JSONObject body, String bearer) throws Exception {
  URI url = new URI(environment.api() + path);
  if (!CloudSignInRoutes.origin(config(), url.getScheme(), url.getHost(), url.getPort()) || !CloudSignInRoutes.route(url.getRawPath(), "POST", true) || url.getRawQuery() != null)
   throw new IllegalArgumentException();
  if (current != null && current.cancelled) throw new SignInFailure("cancelled");
  Fetched fetched = fetch(url, body.toString().getBytes(StandardCharsets.UTF_8), bearer, current, 20000, 30000);
  return response(fetched);
 }
 /** The readiness probe's one POST: an empty object to a fixed sign-in route, short timeouts; only the status is used. */
 private int probePost(CloudSignInEnvironment environment, String path) throws Exception {
  URI url = new URI(environment.api() + path);
  if (!CloudSignInRoutes.origin(config(), url.getScheme(), url.getHost(), url.getPort()) || !CloudSignInRoutes.route(url.getRawPath(), "POST", true) || url.getRawQuery() != null)
   throw new IllegalArgumentException();
  return fetch(url, "{}".getBytes(StandardCharsets.UTF_8), null).status;
 }
 /** Readiness probe reads: fixed GET routes on the Cloud API, nothing followed. */
 private Response get(String text) throws Exception {
  URI url = new URI(text);
  if (!CloudSignInRoutes.origin(config(), url.getScheme(), url.getHost(), url.getPort()) || !CloudSignInRoutes.route(url.getRawPath(), "GET", false))
   throw new IllegalArgumentException();
  return response(fetch(url, null, null));
 }
 private static Response response(Fetched fetched) throws SignInFailure {
  JSONObject data = new JSONObject();
  if (!fetched.body.isEmpty()) {
   try { Object parsed = new JSONTokener(fetched.body).nextValue(); if (parsed instanceof JSONObject) data = (JSONObject) parsed; else if (fetched.status < 300) throw new SignInFailure("unavailable"); }
   catch (SignInFailure invalid) { throw invalid; }
   catch (Exception invalid) { if (fetched.status < 300) throw new SignInFailure("unavailable"); }
  }
  return new Response(fetched.status, data, fetched.location, fetched.retryAfter);
 }
 private Fetched fetch(URI url, byte[] body, String bearer) throws Exception {
  return fetch(url, body, bearer, null, CloudSignInReadiness.REQUEST_TIMEOUT_MS, CloudSignInReadiness.REQUEST_TIMEOUT_MS);
 }
 /** One request: no redirects followed (a redirect's Location is reported, never loaded), bounded body. */
 private Fetched fetch(URI url, byte[] body, String bearer, Attempt current, int connectTimeout, int readTimeout) throws Exception {
  HttpURLConnection connection = null;
  try {
   connection = (HttpURLConnection) url.toURL().openConnection();
   if (current != null) current.connection = connection;
   connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
   connection.setConnectTimeout(connectTimeout); connection.setReadTimeout(readTimeout); connection.setRequestMethod(body == null ? "GET" : "POST");
   connection.setRequestProperty("Accept", "application/json");
   if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
   // A saved Cloud key (the renewal request) is also presented as an API key; a Steward session never is.
   if (bearer != null && bearer.startsWith("eliza_mobile_")) connection.setRequestProperty("X-API-Key", bearer);
   if (body != null) {
    connection.setRequestProperty("Content-Type", "application/json");
    connection.setDoOutput(true); connection.setFixedLengthStreamingMode(body.length);
    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
   }
   int status = connection.getResponseCode();
   if (status >= 300 && status < 400) return new Fetched(status, "", connection.getHeaderField("Location"));
   if (connection.getContentLengthLong() > RESPONSE_LIMIT) throw new SignInFailure("unavailable");
   byte[] bytes;
   try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) { bytes = readBounded(input); }
   if (current != null && current.cancelled) throw new SignInFailure("cancelled");
   return new Fetched(status, new String(bytes, StandardCharsets.UTF_8), null, connection.getHeaderField("Retry-After"));
  } catch (java.net.UnknownHostException | java.net.ConnectException | java.net.NoRouteToHostException offline) {
   throw new SignInFailure(current != null && current.cancelled ? "cancelled" : "offline");
  } catch (java.io.IOException transport) {
   throw new SignInFailure(current != null && current.cancelled ? "cancelled" : "unavailable");
  } finally {
   if (connection != null) connection.disconnect();
   if (current != null) current.connection = null;
  }
 }
 private static final class Fetched {
  final int status; final String body, location, retryAfter;
  Fetched(int status, String body, String location) { this(status, body, location, null); }
  Fetched(int status, String body, String location, String retryAfter) { this.status = status; this.body = body; this.location = location; this.retryAfter = retryAfter; }
 }
 private static byte[] readBounded(InputStream input) throws Exception {
  if (input == null) return new byte[0];
  ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
  while ((count = input.read(buffer)) != -1) { if (output.size() + count > RESPONSE_LIMIT) throw new SignInFailure("unavailable"); output.write(buffer, 0, count); }
  return output.toByteArray();
 }
}
