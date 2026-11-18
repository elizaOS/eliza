// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CodeSignIn.Verified;
import ai.eliza.plugins.signin.GoogleSignIn.Authorized;
import ai.eliza.plugins.signin.GoogleSignIn.Challenge;
import ai.eliza.plugins.signin.GoogleSignIn.Picked;
import ai.eliza.plugins.signin.GoogleSignIn.SecretServerCode;
import ai.eliza.plugins.signin.ReadinessPolicy.DeviceFacts;
import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import ai.eliza.plugins.signin.SignInCustody.Held;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Refused;
import ai.eliza.plugins.signin.SignInCustody.Session;
import ai.eliza.plugins.signin.SignInPolicy.Event;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.Google;
import ai.eliza.plugins.signin.SignInPolicy.Method;
import ai.eliza.plugins.signin.SignInPolicy.Purpose;
import ai.eliza.plugins.signin.SignInPolicy.State;
import ai.eliza.plugins.signin.SignInPolicy.Step;
import ai.eliza.plugins.signin.SignInPolicy.Verify;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.CancellationSignal;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ElizaSignIn")
public class ElizaSignInPlugin extends Plugin {
  private static final class Open {
    final String requestId, attemptId = UUID.randomUUID().toString();
    final SignInRegistration.Environment environment;
    final Method method;
    final Purpose purpose;
    final String destination, verifier = SignInPolicy.newVerifier();
    final CancellationSignal cancellation = new CancellationSignal();
    long expiresAt, resendAt;
    String challengeId = "";
    List<String> factors = List.of();
    Challenge google;
    String idToken;
    SecretServerCode serverCode;
    int custodyAttempt;
    PluginCall waiting;
    boolean settled;

    Open(String requestId, SignInRegistration.Environment environment, Method method, Purpose purpose, String destination) {
      this.requestId = requestId; this.environment = environment; this.method = method; this.purpose = purpose; this.destination = destination;
    }

    Open resent(String id) { return new Open(id, environment, method, purpose, destination); }
  }

  private final Object lock = new Object();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Map<Method, Long> sendAllowedAt = new EnumMap<>(Method.class);
  private State state = SignInPolicy.INITIAL;
  private Open open, resending;
  private SignInRegistration registration;
  private CodeSignIn codes;
  private GoogleSignIn google;
  private SignInReadiness readiness;
  private SignInCustody custody;
  private GoogleSignIn.Browser browser;

  protected SignInCustody custody(Context context, SignInRegistration registration) {
    return DeviceCredentialStore.custody(context, registration);
  }

  protected GoogleSignIn.Browser browser(SignInRegistration registration, SignInCustody custody) {
    return BrowserSignIn.browser(this, registration);
  }

  protected DeviceFacts deviceFacts() {
    return new DeviceFacts(registration.googleMode, true, true);
  }

  @Override public void load() {
    registration = SignInRegistration.parse(map(getConfig().getConfigJSON()));
    codes = new CodeSignIn(CodeSignIn.CONNECTION, registration.clientId);
    google = new GoogleSignIn(CodeSignIn.CONNECTION, registration);
    custody = custody(getContext(), registration);
    browser = browser(registration, custody);
    SharedPreferences preferences = getContext().getSharedPreferences("eliza-sign-in-readiness", Context.MODE_PRIVATE);
    readiness = new SignInReadiness(registration, url -> {
      CodeSignIn.Answer answer = CodeSignIn.CONNECTION.send("GET", url, null, null);
      return new SignInReadiness.Response(answer.status(), answer.body().toString());
    }, new SignInReadiness.Store() {
      @Override public String get(String key) { return preferences.getString(key, null); }
      @Override public void put(String key, String value) { preferences.edit().putString(key, value).apply(); }
    }, worker, System::currentTimeMillis, this::deviceFacts,
      (environment, status) -> notifyListeners("signInReadinessChanged", readiness(environment, status)));
    readiness.load();
  }

  @Override protected void handleOnResume() {
    boolean active;
    synchronized (lock) { active = state.step().open(); }
    if (readiness != null) readiness.resume(active);
  }

  @Override protected void handleOnDestroy() {
    Open current;
    synchronized (lock) { current = open; }
    if (current != null) cancelled(current, Failure.CANCELLED);
    worker.shutdownNow();
  }

  @PluginMethod public void status(PluginCall call) {
    SignInRegistration.Environment environment = registration.environment(call.getString("environment"));
    if (environment == null || !readiness.status(environment.name, Boolean.TRUE.equals(call.getBoolean("retry", false)),
        status -> call.resolve(readiness(environment.name, status).put("account", account())))) refuse(call, Failure.INVALID_REQUEST);
  }

  @PluginMethod public void serviceInfo(PluginCall call) {
    readiness.service(call.getString("environment"), service -> {
      JSObject answer = new JSObject().put("outcome", service.outcome.name().toLowerCase(Locale.ROOT));
      if (service.body != null) answer.put("service", CodeSignIn.object(service.body).optJSONObject("service"));
      call.resolve(answer);
    });
  }

  @PluginMethod public void startEmail(PluginCall call) { startCode(call, Method.EMAIL_CODE, purpose(call)); }

  @PluginMethod public void startPhone(PluginCall call) { startCode(call, Method.SMS_CODE, purpose(call)); }

  @PluginMethod public void startGoogle(PluginCall call) {
    Purpose purpose = purpose(call);
    startGoogle(call, purpose == Purpose.REAUTHENTICATE ? Method.GOOGLE_BROWSER : Method.google(registration.googleMode), purpose);
  }

  @PluginMethod public void reauthenticate(PluginCall call) {
    switch (call.getString("method", "")) {
      case "email" -> startCode(call, Method.EMAIL_CODE, Purpose.REAUTHENTICATE);
      case "sms" -> startCode(call, Method.SMS_CODE, Purpose.REAUTHENTICATE);
      case "google" -> startGoogle(call, Method.GOOGLE_BROWSER, Purpose.REAUTHENTICATE);
      default -> refuse(call, Failure.INVALID_REQUEST);
    }
  }

  @PluginMethod public void resend(PluginCall call) {
    String id = call.getString("requestId");
    if (!SignInPolicy.validUuid(id)) { refuse(call, Failure.INVALID_REQUEST); return; }
    Open next;
    synchronized (lock) {
      long allowedAt = open == null ? 0 : sendAllowedAt.getOrDefault(open.method, 0L);
      if (open != null && System.currentTimeMillis() < allowedAt) { refuse(call, Failure.BUSY, allowedAt); return; }
      if (open == null || !apply(new Event.Resend(id))) { refuse(call, Failure.BUSY); return; }
      next = open.resent(id);
      resending = next;
    }
    send(call, next);
  }

  @PluginMethod public void verify(PluginCall call) {
    String id = call.getString("requestId"), code = call.getString("code"), factor = call.getString("method");
    if (!SignInPolicy.validCode(code)) { refuse(call, Failure.INVALID_CODE); return; }
    Open current;
    boolean second;
    synchronized (lock) {
      current = open;
      if (current == null || !current.requestId.equals(id)) { refuse(call, Failure.INVALID_REQUEST); return; }
      second = state.step() == Step.SECOND_FACTOR;
      String chosen = second ? (factor == null && current.factors.size() == 1 ? current.factors.get(0) : factor) : null;
      if (second && !current.factors.contains(chosen)) { refuse(call, Failure.INVALID_REQUEST); return; }
      if (!apply(new Event.Submit(id))) { refuse(call, Failure.BUSY); return; }
      current.waiting = call;
      factor = chosen;
    }
    if (System.currentTimeMillis() >= current.expiresAt) { fail(current, Failure.EXPIRED); return; }
    String chosenFactor = factor;
    run(current, () -> {
      Verified verified = second ? codes.completeFactor(current.environment, current.challengeId, chosenFactor, code)
        : codes.verify(current.environment, current.method, current.destination, code, current.verifier);
      verified(current, verified);
    });
  }

  @PluginMethod public void sendFactorCode(PluginCall call) {
    Open current;
    synchronized (lock) {
      current = open;
      if (current == null || !current.requestId.equals(call.getString("requestId")) || state.step() != Step.SECOND_FACTOR
          || !current.factors.contains("sms")) { refuse(call, Failure.INVALID_REQUEST); return; }
    }
    run(current, () -> {
      try { codes.sendFactorCode(current.environment, current.challengeId); call.resolve(new JSObject().put("requestId", current.requestId)); }
      catch (Refused refused) { refuse(call, refused.failure); }
    });
  }

  @PluginMethod public void cancel(PluginCall call) {
    String id = call.getString("requestId", "");
    Open current, resend;
    synchronized (lock) {
      current = open != null && open.requestId.equals(id) ? open : null;
      resend = resending != null && resending.requestId.equals(id) ? resending : null;
      if ((current == null && resend == null) || !apply(new Event.Cancel(id))) { call.resolve(new JSObject().put("cancelled", false)); return; }
      if (resend != null) { resending = null; resend.settled = true; }
    }
    if (resend != null) refuse(resend.waiting, Failure.CANCELLED);
    else stopped(current);
    call.resolve(new JSObject().put("cancelled", true));
  }

  @PluginMethod public void signOut(PluginCall call) {
    Open current;
    synchronized (lock) { current = open; }
    if (current != null) cancelled(current, Failure.CANCELLED);
    try {
      worker.execute(() -> { custody.signOut(); call.resolve(new JSObject().put("account", account())); });
    } catch (RejectedExecutionException closed) {
      refuse(call, Failure.UNAVAILABLE);
    }
  }

  private void startCode(PluginCall call, Method method, Purpose purpose) {
    String raw = call.getString(method == Method.SMS_CODE ? "phone" : "email");
    String destination = raw == null ? null : method == Method.SMS_CODE ? raw.trim() : raw.trim().toLowerCase(Locale.ROOT);
    if (!SignInPolicy.validDestination(method, destination)) { refuse(call, Failure.INVALID_REQUEST); return; }
    Open next = opened(call, method, purpose, destination);
    if (next != null) send(call, next);
  }

  private void startGoogle(PluginCall call, Method method, Purpose purpose) {
    Open next = opened(call, method, purpose, null);
    if (next == null) return;
    synchronized (lock) { next.waiting = call; }
    if (method == Method.GOOGLE_BROWSER) { browser.open(next.requestId, next.environment, purpose, returned(next)); return; }
    run(next, () -> {
      Challenge challenge = google.challenge(next.environment, System.currentTimeMillis());
      synchronized (lock) { next.google = challenge; next.expiresAt = challenge.expiresAt(); }
      getActivity().runOnUiThread(() -> GoogleSignIn.pick(getActivity(), challenge, next.cancellation, picked -> picked(next, picked)));
    });
  }

  private Open opened(PluginCall call, Method method, Purpose purpose, String destination) {
    String id = call.getString("requestId");
    SignInRegistration.Environment environment = registration.environment(call.getString("environment"));
    if (!SignInPolicy.validUuid(id) || environment == null) { refuse(call, Failure.INVALID_REQUEST); return null; }
    if (!SignInPolicy.admitted(method, purpose, registration.googleMode)) { refuse(call, Failure.REFUSED); return null; }
    if (purpose == Purpose.REAUTHENTICATE && custody.held() == null) { refuse(call, Failure.REFUSED); return null; }
    synchronized (lock) {
      long allowedAt = method.code() ? sendAllowedAt.getOrDefault(method, 0L) : 0;
      if (System.currentTimeMillis() < allowedAt) { refuse(call, Failure.BUSY, allowedAt); return null; }
      if (!apply(new Event.Open(id, method, purpose))) { refuse(call, Failure.BUSY); return null; }
      open = new Open(id, environment, method, purpose, destination);
      resending = null;
      return open;
    }
  }

  private void send(PluginCall call, Open next) {
    synchronized (lock) { next.waiting = call; }
    run(next, () -> {
      CodeSignIn.Sent sent;
      try {
        sent = codes.send(next.environment, next.method, next.destination, next.verifier, System.currentTimeMillis());
      } catch (CodeSignIn.NotSent refused) {
        synchronized (lock) { if (refused.resendAt > 0) sendAllowedAt.merge(next.method, refused.resendAt, Math::max); }
        fail(next, refused.failure, refused.resendAt);
        return;
      }
      synchronized (lock) {
        sendAllowedAt.merge(next.method, sent.resendAt(), Math::max);
        if (!apply(new Event.CodeSent(next.requestId))) return;
        next.expiresAt = sent.expiresAt(); next.resendAt = sendAllowedAt.get(next.method);
        if (next != open) { open.cancellation.cancel(); open = next; resending = null; }
        next.waiting = null;
      }
      call.resolve(new JSObject().put("requestId", next.requestId).put("attemptId", next.attemptId)
        .put("step", Step.CODE_SENT.wire).put("expiresAt", next.expiresAt).put("resendAt", next.resendAt));
    });
  }

  private void picked(Open current, Picked picked) {
    if (picked instanceof Picked.NotPicked refused) { fail(current, refused.failure()); return; }
    Picked.Token token = (Picked.Token) picked;
    synchronized (lock) { current.idToken = token.idToken(); }
    List<String> scopes = registration.googleScopes();
    if (scopes.isEmpty()) { proofReady(current, Google.NOT_REQUESTED, null); return; }
    GoogleSignIn.authorize(getActivity(), current.google, token.account(), scopes, current.cancellation, authorized ->
      proofReady(current, authorized instanceof Authorized.Code ? Google.HELD : Google.REFUSED,
        authorized instanceof Authorized.Code code ? code.code() : null));
  }

  private void proofReady(Open current, Google custodyOfCode, SecretServerCode code) {
    synchronized (lock) {
      if (!apply(new Event.ProofReady(current.requestId, custodyOfCode))) { if (code != null) code.drop(); return; }
      current.serverCode = code;
    }
    run(current, () -> {
      if (System.currentTimeMillis() >= current.google.expiresAt()) throw new Refused(Failure.EXPIRED);
      int attempt = begin(current);
      GoogleSignIn.SignedIn answer = google.signIn(current.environment, current.google, current.idToken, current.serverCode, System.currentTimeMillis());
      if (answer instanceof GoogleSignIn.SignedIn.FactorRequired factor) {
        custody.signInEnded(attempt);
        factorRequired(current, new Event.FactorRequired(current.requestId), factor.challengeId(), factor.methods(), factor.expiresAt());
        return;
      }
      GoogleSignIn.SignedIn.Minted minted = (GoogleSignIn.SignedIn.Minted) answer;
      if (minted.googleConnected() != null) synchronized (lock) { apply(new Event.GoogleSettled(current.requestId, minted.googleConnected())); }
      acknowledged(current, custody.redeem(attempt, current.environment, minted.proof(), minted.answer()));
    });
  }

  private GoogleSignIn.Returned returned(Open current) {
    return new GoogleSignIn.Returned() {
      @Override public void answered(Verified exchange) {
        synchronized (lock) { if (!apply(new Event.ProofReady(current.requestId, Google.NOT_REQUESTED))) return; }
        run(current, () -> {
          if (exchange instanceof Verified.SignedIn signedIn) signedIn(current, signedIn.session());
          else if (exchange instanceof Verified.FactorRequired factor)
            factorRequired(current, new Event.FactorRequired(current.requestId), factor.challengeId(), factor.methods(), factor.expiresAt());
          else fail(current, failureOf(((Verified.NotVerified) exchange).answer()));
        });
      }

      @Override public void failed(Failure failure) { fail(current, failure); }
    };
  }

  private void verified(Open current, Verified verified) throws Refused {
    switch (verified) {
      case Verified.SignedIn signedIn -> {
        synchronized (lock) { if (!apply(new Event.VerifyAnswered(current.requestId, Verify.VERIFIED))) return; }
        signedIn(current, signedIn.session());
      }
      case Verified.FactorRequired factor ->
        factorRequired(current, new Event.VerifyAnswered(current.requestId, Verify.FACTOR_REQUIRED), factor.challengeId(), factor.methods(), factor.expiresAt());
      case Verified.NotVerified not -> {
        PluginCall waiting;
        synchronized (lock) {
          if (!apply(new Event.VerifyAnswered(current.requestId, not.answer()))) return;
          if (!state.step().open()) waiting = null;
          else { waiting = current.waiting; current.waiting = null; }
        }
        if (waiting == null) { settle(current); return; }
        Failure kept = not.answer() == Verify.WRONG_CODE ? Failure.INVALID_CODE : Failure.UNAVAILABLE;
        waiting.reject(kept.wire, kept.wire, new JSObject().put("requestId", current.requestId).put("step", state().step().wire).put("kept", true));
      }
    }
  }

  private void signedIn(Open current, Session session) throws Refused {
    if (current.purpose == Purpose.REAUTHENTICATE) {
      Held held = custody.held();
      if (held == null || !custody.grantSession(session)) throw new Refused(Failure.REFUSED);
      acknowledged(current, held.credentialId());
      return;
    }
    int attempt = begin(current);
    Proof proof;
    try { proof = custody.connect(attempt, current.environment, session.accessToken()); }
    finally { codes.logout(current.environment, session); }
    acknowledged(current, custody.redeem(attempt, current.environment, proof, null));
  }

  private void acknowledged(Open current, String credentialId) {
    boolean connect;
    synchronized (lock) {
      if (!apply(new Event.Acknowledged(current.requestId, credentialId))) return;
      connect = state.google() == Google.HELD;
    }
    if (connect) {
      Held held = custody.held();
      boolean connected = held != null && google.connectNative(current.environment, held.key(), current.serverCode);
      synchronized (lock) { apply(new Event.GoogleSettled(current.requestId, connected)); }
    }
    settle(current);
  }

  private void factorRequired(Open current, Event event, String challengeId, List<String> methods, long expiresAt) {
    PluginCall waiting;
    synchronized (lock) {
      if (!apply(event)) return;
      if (state.step() != Step.SECOND_FACTOR) waiting = null;
      else {
        current.challengeId = challengeId; current.factors = List.copyOf(methods); current.expiresAt = expiresAt;
        waiting = current.waiting; current.waiting = null;
      }
    }
    if (waiting == null) { settle(current); return; }
    waiting.resolve(new JSObject().put("requestId", current.requestId).put("attemptId", current.attemptId)
      .put("step", Step.SECOND_FACTOR.wire).put("methods", new JSArray(methods)).put("expiresAt", expiresAt));
  }

  private int begin(Open current) {
    int attempt = custody.beginSignIn();
    synchronized (lock) { current.custodyAttempt = attempt; }
    return attempt;
  }

  private void fail(Open current, Failure failure) { fail(current, failure, 0); }

  private void fail(Open current, Failure failure, long resendAt) {
    boolean resend;
    synchronized (lock) {
      resend = current == resending;
      if (!apply(new Event.Fail(current.requestId, failure))) return;
      if (resend) { resending = null; current.settled = true; }
    }
    if (resend) refuse(current.waiting, failure, resendAt);
    else stopped(current);
  }

  private void cancelled(Open current, Failure failure) {
    synchronized (lock) { if (!apply(new Event.Cancel(current.requestId))) return; }
    stopped(current);
  }

  private void stopped(Open current) {
    current.cancellation.cancel();
    if (current.serverCode != null) current.serverCode.drop();
    if (current.method == Method.GOOGLE_BROWSER) browser.cancel(current.requestId);
    if (current.custodyAttempt > 0 && current.purpose == Purpose.SIGN_IN) custody.signInEnded(current.custodyAttempt);
    settle(current);
  }

  private void settle(Open current) {
    State settled;
    PluginCall waiting;
    synchronized (lock) {
      settled = state;
      if (current.settled || !current.requestId.equals(settled.request()) || settled.step().open()) return;
      current.settled = true;
      waiting = current.waiting;
      current.waiting = null;
    }
    if (current.serverCode != null) current.serverCode.drop();
    JSObject receipt = new JSObject().put("requestId", current.requestId).put("attemptId", current.attemptId)
      .put("credentialId", settled.credentialId()).put("google", settled.google().wire).put("step", settled.step().wire);
    if (settled.failure() != null) receipt.put("failure", settled.failure().wire);
    notifyListeners("signInSettled", receipt);
    if (waiting == null) return;
    if (settled.failure() == null) waiting.resolve(receipt);
    else waiting.reject(settled.failure().wire, settled.failure().wire, receipt);
  }

  private interface Work {
    void run() throws Refused;
  }

  private void run(Open current, Work work) {
    try {
      worker.execute(() -> {
        try { work.run(); }
        catch (Refused refused) { fail(current, refused.failure); }
        catch (RuntimeException broken) { fail(current, Failure.UNAVAILABLE); }
      });
    } catch (RejectedExecutionException closed) {
      fail(current, Failure.UNAVAILABLE);
    }
  }

  private boolean apply(Event event) {
    if (!SignInPolicy.enabled(state, event)) return false;
    state = SignInPolicy.step(state, event);
    return true;
  }

  private State state() { synchronized (lock) { return state; } }

  private static Failure failureOf(Verify answer) {
    return switch (answer) {
      case WRONG_CODE -> Failure.INVALID_CODE;
      case LOCKED -> Failure.TOO_MANY_ATTEMPTS;
      case EXPIRED -> Failure.EXPIRED;
      case REFUSED -> Failure.REFUSED;
      case VERIFIED, FACTOR_REQUIRED, UNANSWERED, MALFORMED -> Failure.UNAVAILABLE;
    };
  }

  private static Purpose purpose(PluginCall call) {
    return "reauthenticate".equals(call.getString("purpose")) ? Purpose.REAUTHENTICATE : Purpose.SIGN_IN;
  }

  private JSObject account() {
    Held held = custody.held();
    if (held == null) return new JSObject().put("signedIn", false);
    return new JSObject().put("signedIn", true).put("userId", held.account().userId()).put("organizationId", held.account().organizationId())
      .put("credentialId", held.credentialId()).put("keyExpiresAt", held.keyExpiresAt());
  }

  private static JSObject readiness(String environment, SignInReadiness.Status status) {
    return new JSObject().put("environment", environment).put("methodsKnown", status.methodsKnown).put("email", status.email)
      .put("sms", status.sms).put("google", status.google).put("googleMode", status.googleMode == GoogleMode.BROWSER ? "browser" : "picker");
  }

  private static void refuse(PluginCall call, Failure failure) { refuse(call, failure, 0); }

  private static void refuse(PluginCall call, Failure failure, long resendAt) {
    if (call == null) return;
    if (resendAt > 0) call.reject(failure.wire, failure.wire, new JSObject().put("resendAt", resendAt));
    else call.reject(failure.wire, failure.wire);
  }

  private static Map<String, Object> map(JSONObject object) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
      String key = keys.next();
      out.put(key, value(object.opt(key)));
    }
    return out;
  }

  private static Object value(Object raw) {
    if (raw instanceof JSONObject object) return map(object);
    if (raw instanceof JSONArray array) {
      List<Object> out = new ArrayList<>();
      for (int i = 0; i < array.length(); i++) out.add(value(array.opt(i)));
      return out;
    }
    return raw == JSONObject.NULL ? null : raw;
  }
}
