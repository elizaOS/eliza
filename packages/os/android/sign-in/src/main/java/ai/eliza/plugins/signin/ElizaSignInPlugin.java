// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CodeSignIn.Checked;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.GoogleSignIn.Authorized;
import ai.eliza.plugins.signin.GoogleSignIn.Picked;
import ai.eliza.plugins.signin.GoogleSignIn.SecretServerCode;
import ai.eliza.plugins.signin.ReadinessPolicy.DeviceFacts;
import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import ai.eliza.plugins.signin.SignInCustody.Held;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Refused;
import ai.eliza.plugins.signin.SignInCustody.Session;
import ai.eliza.plugins.signin.SignInPolicy.BuildKind;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInPolicy.Effect;
import ai.eliza.plugins.signin.SignInPolicy.Event;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.GoogleReport;
import ai.eliza.plugins.signin.SignInPolicy.KeyOutcome;
import ai.eliza.plugins.signin.SignInPolicy.Method;
import ai.eliza.plugins.signin.SignInPolicy.PhaseTag;
import ai.eliza.plugins.signin.SignInPolicy.PickerResult;
import ai.eliza.plugins.signin.SignInPolicy.Registration;
import ai.eliza.plugins.signin.SignInPolicy.ServerCode;
import ai.eliza.plugins.signin.SignInPolicy.State;
import ai.eliza.plugins.signin.SignInPolicy.Step;
import ai.eliza.plugins.signin.SignInPolicy.Verdict;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.os.CancellationSignal;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ElizaSignIn")
public class ElizaSignInPlugin extends Plugin {
  private static final String TAG = "ElizaSignIn";
  private static final class Attempt {
    final int number;
    final SignInRegistration.Environment environment;
    final Method method;
    final boolean reauthenticating;
    final CredentialPolicy.MailLeaseUpgrade upgrade;
    final String destination, verifier = SignInPolicy.newVerifier();
    final CancellationSignal cancellation = new CancellationSignal();
    long expiresAt, resendAt, expiryAt;
    String challengeId = "";
    List<String> factors = List.of();
    GoogleSignIn.Challenge challenge;
    String idToken;
    SecretServerCode serverCode;
    Session session;
    boolean handed;
    ScheduledFuture<?> expiry;

    Attempt(int number, SignInRegistration.Environment environment, Method method, boolean reauthenticating, String destination) {
      this(number, environment, method, reauthenticating, destination, null);
    }

    Attempt(int number, SignInRegistration.Environment environment, Method method, boolean reauthenticating, String destination, CredentialPolicy.MailLeaseUpgrade upgrade) {
      this.number = number; this.environment = environment; this.method = method; this.reauthenticating = reauthenticating; this.destination = destination;
      this.upgrade = upgrade;
    }

    @Override public String toString() { return "Attempt[" + number + ", " + method + "]"; }
  }

  private final Object lock = new Object();
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
  private final Map<Method, Long> sendAllowedAt = new EnumMap<>(Method.class);
  private final Map<Integer, Attempt> attempts = new HashMap<>();
  private final Map<Integer, PluginCall> calls = new HashMap<>();
  private State state = SignInPolicy.INITIAL;
  private SignInRegistration registration;
  private CodeSignIn codes;
  private GoogleSignIn google;
  private SignInReadiness readiness;
  private SignInCustody custody;
  private GoogleSignIn.Browser browser;

  protected SignInCustody custody(Context context, SignInRegistration registration) {
    return DeviceCustody.custody(context, registration);
  }

  protected GoogleSignIn.Browser browser(SignInRegistration registration, SignInCustody custody) {
    return BrowserSignIn.browser(this, registration, custody);
  }

  protected CodeSignIn.Http http() { return CodeSignIn.CONNECTION; }

  protected DeviceFacts deviceFacts() {
    Context context = getContext();
    boolean verified = registration.environments().stream().allMatch(environment -> BrowserSignIn.appLinkVerified(context, environment));
    return new DeviceFacts(registration.googleMode, verified, BrowserSignIn.externalBrowser(context, registration.production().apiOrigin) != null);
  }

  @Override public void load() {
    BuildKind build = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0 ? BuildKind.DEBUG_BUILD : BuildKind.RELEASE_BUILD;
    try { registration = SignInRegistration.parse(map(getConfig().getConfigJSON())); }
    catch (SignInRegistration.Refused refused) { registration = null; }
    Registration loaded = registration == null ? new Registration(false, false, false)
      : new Registration(true, !registration.googleScopes().isEmpty(), registration.testEnvironmentsEnabled);
    dispatch(new Event.Load(loaded, build));
    if (registration == null) return;
    codes = new CodeSignIn(http(), registration.clientId);
    google = new GoogleSignIn(http(), registration);
    custody = custody(getContext(), registration);
    browser = browser(registration, custody);
    SharedPreferences preferences = getContext().getSharedPreferences("eliza-sign-in-readiness", Context.MODE_PRIVATE);
    CodeSignIn.Http http = http();
    readiness = new SignInReadiness(registration, url -> {
      CodeSignIn.Answer answer = http.send("GET", url, null, null);
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
    synchronized (lock) { active = state.open() != 0; }
    if (readiness != null) readiness.resume(active);
  }

  @Override protected void handleOnDestroy() {
    int current;
    synchronized (lock) { current = state.attempt(); }
    if (current > 0) dispatch(new Event.Cancel(current));
    worker.shutdownNow();
    timers.shutdownNow();
  }

  @PluginMethod public void status(PluginCall call) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    readiness.status(environment.name, Boolean.TRUE.equals(call.getBoolean("retry", false)),
      status -> call.resolve(readiness(environment.name, status).put("account", account(environment))));
  }

  @PluginMethod public void serviceInfo(PluginCall call) {
    if (registration == null) { reject(call, Failure.REJECTED); return; }
    readiness.service(call.getString("environment"), service -> {
      JSObject answer = new JSObject().put("outcome", service.outcome.name().toLowerCase(Locale.ROOT));
      if (service.body != null) answer.put("service", CodeSignIn.object(service.body).optJSONObject("service"));
      call.resolve(answer);
    });
  }

  @PluginMethod public void startEmail(PluginCall call) { startCode(call, Method.EMAIL_CODE, false); }

  @PluginMethod public void startPhone(PluginCall call) { startCode(call, Method.SMS_CODE, false); }

  @PluginMethod public void startGoogle(PluginCall call) {
    if (registration == null) { reject(call, Failure.REJECTED); return; }
    startGoogle(call, Method.google(registration.googleMode), false);
  }

  protected final void startGoogleInBrowser(PluginCall call) {
    startGoogle(call, Method.GOOGLE_BROWSER, false);
  }

  @PluginMethod public void reauthenticate(PluginCall call) {
    switch (call.getString("method", "")) {
      case "email" -> startCode(call, Method.EMAIL_CODE, true);
      case "sms" -> startCode(call, Method.SMS_CODE, true);
      case "google" -> startGoogle(call, Method.GOOGLE_BROWSER, true);
      default -> reject(call, Failure.INVALID_INPUT);
    }
  }

  @PluginMethod public void upgradeMailLease(PluginCall call) {
    upgradeMailLease(call, Method.GOOGLE_BROWSER);
  }

  protected final void upgradeMailLeaseWithPicker(PluginCall call) {
    upgradeMailLease(call, Method.GOOGLE_PICKER);
  }

  private void upgradeMailLease(PluginCall call, Method method) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    try {
      CredentialPolicy.MailLeaseUpgrade expected = custody.mailLeaseUpgrade(environment);
      if (expected == null) { reject(call, Failure.REJECTED); return; }
      openGoogle(call, environment, method, false, expected);
    } catch (DeviceCredentialStore.StorageFailure unavailable) {
      reject(call, Failure.UNAVAILABLE);
    }
  }

  @PluginMethod public void cancelMailLeaseUpgrade(PluginCall call) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    int number;
    synchronized (lock) {
      Attempt attempt = attempts.get(state.attempt());
      number = attempt != null && attempt.environment == environment && attempt.upgrade != null ? attempt.number : 0;
    }
    call.resolve(new JSObject().put("cancelled", number > 0 && cancelAttempt(number)));
  }

  @PluginMethod public void resend(PluginCall call) {
    Integer number = call.getInt("attempt");
    if (number == null) { reject(call, Failure.INVALID_INPUT); return; }
    Attempt earlier;
    long allowedAt;
    synchronized (lock) {
      earlier = attempts.get(number);
      allowedAt = earlier == null ? 0 : sendAllowedAt.getOrDefault(earlier.method, 0L);
    }
    if (earlier == null) { refuse(call, new Event.Resend(number)); return; }
    if (System.currentTimeMillis() < allowedAt) { reject(call, Failure.BUSY, allowedAt); return; }
    Attempt next = open(call, new Event.Resend(number), earlier, false);
    if (next != null) run(() -> send(next));
  }

  @PluginMethod public void verify(PluginCall call) {
    Integer number = call.getInt("attempt");
    String code = call.getString("code"), factor = call.getString("method");
    if (number == null || !SignInPolicy.validCode(code)) { reject(call, Failure.INVALID_INPUT); return; }
    Attempt attempt;
    boolean second;
    synchronized (lock) {
      attempt = attempts.get(number);
      second = state.attempt() == number && state.phase().tag() == PhaseTag.SECOND_FACTOR;
      if (attempt != null && second && factor == null && attempt.factors.size() == 1) factor = attempt.factors.get(0);
    }
    if (attempt == null) { refuse(call, new Event.Verify(number)); return; }
    if (second && !attempt.factors.contains(factor)) { reject(call, Failure.INVALID_INPUT); return; }
    if (open(call, new Event.Verify(number), attempt, true) == null) return;
    String chosen = factor;
    run(() -> checked(attempt, second
      ? codes.completeFactor(attempt.environment, attempt.challengeId, chosen, code, System.currentTimeMillis())
      : codes.verify(attempt.environment, attempt.method, attempt.destination, code, attempt.verifier, System.currentTimeMillis()), 0));
  }

  @PluginMethod public void sendFactorCode(PluginCall call) {
    Integer number = call.getInt("attempt");
    Attempt attempt;
    synchronized (lock) {
      attempt = number == null ? null : attempts.get(number);
      if (attempt != null && (state.attempt() != number || state.phase().tag() != PhaseTag.SECOND_FACTOR || !attempt.factors.contains("sms"))) attempt = null;
    }
    if (attempt == null) { reject(call, Failure.INVALID_INPUT); return; }
    Attempt asked = attempt;
    run(() -> {
      CloudReply reply = codes.sendFactorCode(asked.environment, asked.challengeId);
      if (reply instanceof CloudReply.Delivered) call.resolve(new JSObject().put("attempt", asked.number));
      else reject(call, reply instanceof CloudReply.Refused refused ? SignInPolicy.failureOf(false, refused.code(), refused.reason()) : Failure.UNAVAILABLE);
    });
  }

  @PluginMethod public void cancel(PluginCall call) {
    Integer number = call.getInt("attempt");
    if (number == null) { reject(call, Failure.INVALID_INPUT); return; }
    call.resolve(new JSObject().put("cancelled", cancelAttempt(number)));
  }

  private boolean cancelAttempt(int number) {
    List<Runnable> after;
    boolean changed;
    synchronized (lock) {
      State before = state;
      after = apply(new Event.Cancel(number));
      changed = after != null && !state.equals(before);
    }
    if (after != null) after.forEach(Runnable::run);
    return changed;
  }

  @PluginMethod public void signOut(PluginCall call) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    int current;
    synchronized (lock) { current = state.attempt(); }
    if (current > 0) dispatch(new Event.Cancel(current));
    try {
      worker.execute(() -> {
        try {
          custody.signOut(environment);
          call.resolve(new JSObject().put("account", account(environment)));
        } catch (RuntimeException notSettled) {
          reject(call, Failure.UNAVAILABLE);
        }
      });
    } catch (RejectedExecutionException closed) {
      reject(call, Failure.UNAVAILABLE);
    }
  }

  private void startCode(PluginCall call, Method method, boolean reauthenticating) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    String raw = call.getString(method == Method.SMS_CODE ? "phone" : "email");
    String destination = raw == null ? null : method == Method.SMS_CODE ? raw.trim() : raw.trim().toLowerCase(Locale.ROOT);
    if (!SignInPolicy.validDestination(method, destination)) { reject(call, Failure.INVALID_INPUT); return; }
    long allowedAt;
    synchronized (lock) { allowedAt = sendAllowedAt.getOrDefault(method, 0L); }
    if (System.currentTimeMillis() < allowedAt) { reject(call, Failure.BUSY, allowedAt); return; }
    Event event = startEvent(call, environment, method, reauthenticating);
    if (event == null) return;
    Attempt opened = open(call, event, new Attempt(0, environment, method, reauthenticating, destination), false);
    if (opened != null) run(() -> send(opened));
  }

  private void startGoogle(PluginCall call, Method method, boolean reauthenticating) {
    SignInRegistration.Environment environment = environment(call);
    if (environment == null) return;
    openGoogle(call, environment, method, reauthenticating, null);
  }

  private void openGoogle(PluginCall call, SignInRegistration.Environment environment, Method method, boolean reauthenticating,
                          CredentialPolicy.MailLeaseUpgrade upgrade) {
    Event event = startEvent(call, environment, method, reauthenticating);
    if (event == null) return;
    Attempt opened = open(call, event, new Attempt(0, environment, method, reauthenticating, null, upgrade), false);
    if (opened == null) return;
    if (method == Method.GOOGLE_BROWSER) {
      browser.open(opened.number, environment, reauthenticating || upgrade != null, new GoogleSignIn.Returned() {
        @Override public void exchanged(int credentialAttempt, Checked answer) {
          run(() -> checked(opened, answer, credentialAttempt));
        }

        @Override public void refused(Failure problem) {
          run(() -> signInRefused(opened, problem));
        }
      });
      return;
    }
    run(() -> {
      GoogleSignIn.Challenge challenge = google.challenge(environment, System.currentTimeMillis());
      Activity activity = getActivity();
      if (challenge == null || activity == null) { dispatch(new Event.PickerAnswered(opened.number, PickerResult.NO_GOOGLE_ACCOUNT)); return; }
      synchronized (lock) { opened.challenge = challenge; }
      activity.runOnUiThread(() -> GoogleSignIn.pick(activity, challenge, opened.cancellation, picked -> picked(opened, picked)));
    });
  }

  private Event startEvent(PluginCall call, SignInRegistration.Environment environment, Method method, boolean reauthenticating) {
    SignInPolicy.Environment named = environment.name.equals(SignInRegistration.PRODUCTION) ? SignInPolicy.Environment.PRODUCTION : SignInPolicy.Environment.STAGING;
    DeviceFacts device = startDeviceFacts(environment, method);
    ReadinessPolicy.Readiness ready = readiness.admitting(environment.name);
    if (!reauthenticating) return new Event.Start(named, method, ready, device);
    Held held = custody.held(environment);
    if (held == null) { reject(call, Failure.REJECTED); return null; }
    return new Event.Reauthenticate(named, method, ready, device, held.account());
  }

  private DeviceFacts startDeviceFacts(SignInRegistration.Environment environment, Method method) {
    if (method != Method.GOOGLE_BROWSER || !registration.googleBrowserFallback) return deviceFacts();
    Context context = getContext();
    return new DeviceFacts(registration.googleMode, BrowserSignIn.appLinkVerified(context, environment),
      BrowserSignIn.externalBrowser(context, environment.apiOrigin) != null, true);
  }

  private void picked(Attempt attempt, Picked picked) {
    if (picked instanceof Picked.NotPicked refused) { dispatch(new Event.PickerAnswered(attempt.number, refused.result())); return; }
    Picked.Token token = (Picked.Token) picked;
    synchronized (lock) { attempt.idToken = token.idToken(); }
    List<String> scopes = registration.googleScopes();
    if (attempt.upgrade != null || scopes.isEmpty()) { pickerAnswered(attempt, false, null); return; }
    GoogleSignIn.authorize(getActivity(), attempt.challenge, token.account(), scopes, attempt.cancellation, authorized ->
      pickerAnswered(attempt, authorized instanceof Authorized.Code, authorized instanceof Authorized.Code granted ? granted.code() : null));
  }

  private void pickerAnswered(Attempt attempt, boolean granted, SecretServerCode code) {
    synchronized (lock) { attempt.serverCode = code; }
    if (!dispatch(new Event.PickerAnswered(attempt.number, PickerResult.picked(granted)))) {
      if (code != null) code.drop();
      return;
    }
    run(() -> checked(attempt, google.signIn(attempt.environment, attempt.challenge, attempt.idToken, attempt.serverCode, System.currentTimeMillis()), 0));
  }

  private void send(Attempt attempt) {
    CodeSignIn.Sent sent = codes.send(attempt.environment, attempt.method, attempt.destination, attempt.verifier, System.currentTimeMillis());
    synchronized (lock) {
      if (sent.resendAt() > 0) sendAllowedAt.merge(attempt.method, sent.resendAt(), Math::max);
      attempt.expiresAt = sent.expiresAt();
      attempt.resendAt = sendAllowedAt.getOrDefault(attempt.method, 0L);
    }
    dispatch(new Event.CloudAnswered(attempt.number, sent.reply()));
  }

  private void signInRefused(Attempt attempt, Failure problem) {
    if (problem == Failure.CANCELLED) {
      dispatch(new Event.Cancel(attempt.number));
      return;
    }
    CloudReply failure = switch (problem) {
      case EXPIRED -> new CloudReply.Refused(SignInPolicy.RefusalCode.AUTHENTICATION_REQUIRED, CredentialPolicy.Reason.NO_REASON);
      case GOOGLE_UNAVAILABLE -> new CloudReply.Refused(SignInPolicy.RefusalCode.PROVIDER_UNAVAILABLE, CredentialPolicy.Reason.NO_REASON);
      case REJECTED -> new CloudReply.Refused(SignInPolicy.RefusalCode.ACCESS_DENIED, CredentialPolicy.Reason.NO_REASON);
      default -> new CloudReply.Unanswered();
    };
    dispatch(new Event.CloudAnswered(attempt.number, failure));
  }

  private void checked(Attempt attempt, Checked answer, int reserved) {
    switch (answer) {
      case Checked.SessionIssued issued -> sessionIssued(attempt, issued.session(), reserved);
      case Checked.KeyMinted minted -> keyMinted(attempt, minted, reserved);
      case Checked.FactorAsked factor -> {
        synchronized (lock) { attempt.challengeId = factor.challengeId(); attempt.factors = List.copyOf(factor.factors()); attempt.expiresAt = factor.expiresAt(); }
        dispatch(new Event.CloudAnswered(attempt.number, new CloudReply.FactorRequired()));
        if (reserved > 0) custody.signInEnded(attempt.environment, reserved);
      }
      case Checked.NotChecked refused -> {
        dispatch(new Event.CloudAnswered(attempt.number, refused.reply()));
        if (reserved > 0) custody.signInEnded(attempt.environment, reserved);
      }
    }
  }

  private void sessionIssued(Attempt attempt, Session session, int reserved) {
    if (attempt.reauthenticating) {
      synchronized (lock) { attempt.session = session; }
      dispatch(new Event.CloudAnswered(attempt.number,
        new CloudReply.Authenticated(session.account().userId(), 1, session.accessExpiresAt(), GoogleReport.GOOGLE_NOT_REQUESTED)));
      boolean handed;
      synchronized (lock) { handed = attempt.handed; attempt.session = null; }
      if (!handed) codes.logout(attempt.environment, session);
      return;
    }
    if (attempt.upgrade != null && (reserved != 0 || !attempt.upgrade.account().equals(session.account()))) {
      if (reserved > 0) custody.signInEnded(attempt.environment, reserved);
      codes.logout(attempt.environment, session);
      signInRefused(attempt, Failure.REJECTED);
      return;
    }
    int credentialAttempt = reserved > 0 ? reserved : begin(attempt);
    if (credentialAttempt == 0) {
      codes.logout(attempt.environment, session);
      dispatch(new Event.CloudAnswered(attempt.number, new CloudReply.Unanswered()));
      return;
    }
    if (!dispatch(new Event.CloudAnswered(attempt.number,
        new CloudReply.Authenticated(session.account().userId(), credentialAttempt, session.accessExpiresAt(), GoogleReport.GOOGLE_NOT_REQUESTED)))) {
      codes.logout(attempt.environment, session);
      custody.signInEnded(attempt.environment, credentialAttempt);
      return;
    }
    KeyOutcome key;
    try {
      Proof proof;
      try { proof = custody.connect(credentialAttempt, attempt.environment, session.accessToken()); }
      finally { codes.logout(attempt.environment, session); }
      key = KeyOutcome.acknowledged(custody.redeem(credentialAttempt, attempt.environment, proof));
    } catch (Refused refused) {
      key = KeyOutcome.REFUSED;
    }
    exchanged(attempt, credentialAttempt, key);
  }

  private void keyMinted(Attempt attempt, Checked.KeyMinted minted, int reserved) {
    if (attempt.upgrade != null && (reserved != 0 || !minted.belongsTo(attempt.upgrade.account()))) {
      if (reserved > 0) custody.signInEnded(attempt.environment, reserved);
      signInRefused(attempt, Failure.REJECTED);
      return;
    }
    int credentialAttempt = reserved > 0 ? reserved : begin(attempt);
    if (credentialAttempt == 0) { dispatch(new Event.CloudAnswered(attempt.number, new CloudReply.Unanswered())); return; }
    GoogleReport report = attempt.upgrade != null ? GoogleReport.GOOGLE_NOT_REQUESTED
      : minted.googleConnected() ? GoogleReport.GOOGLE_CONNECTED : GoogleReport.GOOGLE_REFUSED;
    if (!dispatch(new Event.CloudAnswered(attempt.number, new CloudReply.Authenticated(minted.account().userId(), credentialAttempt, minted.keyExpiresAt(), report)))) {
      custody.signInEnded(attempt.environment, credentialAttempt);
      return;
    }
    KeyOutcome key;
    try { key = KeyOutcome.acknowledged(custody.redeem(credentialAttempt, attempt.environment, minted.proof())); }
    catch (Refused refused) { key = KeyOutcome.REFUSED; }
    exchanged(attempt, credentialAttempt, key);
  }

  private void exchanged(Attempt attempt, int credentialAttempt, KeyOutcome key) {
    boolean settled = dispatch(new Event.ExchangeSettled(credentialAttempt, key));
    if (!settled || key.tag() == SignInPolicy.KeyTag.KEY_REFUSED) custody.signInEnded(attempt.environment, credentialAttempt);
  }

  private void connectGoogle(Attempt attempt, SecretServerCode code) {
    boolean connected;
    try {
      Held held = custody.held(attempt.environment);
      connected = held != null && google.connectNative(attempt.environment, held.key(), code);
    } catch (RuntimeException failed) {
      Log.e(TAG, "Google connect for attempt " + attempt.number + " failed, so the attempt settles unconnected", failed);
      connected = false;
    }
    if (code != null) code.drop();
    dispatch(new Event.GoogleConnected(attempt.number, connected));
  }

  private int begin(Attempt attempt) {
    try {
      return attempt.upgrade == null ? custody.beginSignIn(attempt.environment)
        : custody.beginMailLeaseUpgrade(attempt.environment, attempt.upgrade);
    }
    catch (Refused unstored) { return 0; }
  }

  private Attempt open(PluginCall call, Event event, Attempt template, boolean same) {
    List<Runnable> after;
    Attempt opened = null;
    Failure refused = null;
    synchronized (lock) {
      after = apply(event);
      if (after == null) refused = refusalOf(event);
      else {
        calls.put(state.open(), call);
        if (same) opened = template;
        else {
          opened = new Attempt(state.attempt(), template.environment, template.method, template.reauthenticating, template.destination, template.upgrade);
          attempts.put(opened.number, opened);
        }
      }
    }
    if (refused != null) { reject(call, refused); return null; }
    after.forEach(Runnable::run);
    return opened;
  }

  private void refuse(PluginCall call, Event event) {
    Failure refused;
    synchronized (lock) { refused = SignInPolicy.enabled(state, event) ? Failure.INVALID_INPUT : refusalOf(event); }
    reject(call, refused);
  }

  private Failure refusalOf(Event event) {
    if (SignInPolicy.isBusy(state.phase())) return Failure.BUSY;
    return switch (event) {
      case Event.Start start -> SignInPolicy.admits(state.plugin(), start.environment()) ? Failure.UNAVAILABLE : Failure.REJECTED;
      case Event.Reauthenticate again -> SignInPolicy.admits(state.plugin(), again.environment()) && again.method() != Method.GOOGLE_PICKER
        ? Failure.UNAVAILABLE : Failure.REJECTED;
      case Event.Verify verify -> ended(verify.attempt());
      case Event.Resend resend -> ended(resend.attempt());
      default -> Failure.INVALID_INPUT;
    };
  }

  private Failure ended(int number) {
    return state.phase().tag() == PhaseTag.FAILED && state.attempt() == number ? state.phase().failure() : Failure.INVALID_INPUT;
  }

  private boolean dispatch(Event event) {
    List<Runnable> after;
    synchronized (lock) { after = apply(event); }
    if (after == null) return false;
    after.forEach(Runnable::run);
    return true;
  }

  private List<Runnable> apply(Event event) {
    if (!SignInPolicy.enabled(state, event)) return null;
    State before = state;
    Step step = SignInPolicy.step(state, event);
    state = step.state();
    List<Runnable> after = new ArrayList<>();
    for (Effect effect : step.out()) after.add(effect(before, effect));
    retire(after);
    schedule();
    return after;
  }

  private Runnable effect(State before, Effect effect) {
    return switch (effect) {
      case Effect.Settled settled -> {
        JSObject receipt = receipt(settled);
        PluginCall waiting = calls.remove(settled.request());
        yield () -> {
          notifyListeners("signInSettled", receipt);
          if (waiting != null) waiting.resolve(receipt);
        };
      }
      case Effect.ConnectGoogle connect -> {
        Attempt attempt = attempts.get(state.attempt());
        SecretServerCode code = attempt == null ? null : attempt.serverCode;
        if (attempt != null) attempt.serverCode = null;
        yield () -> run(() -> connectGoogle(attempt, code));
      }
      case Effect.AbandonExchange abandoned -> {
        Attempt attempt = attempts.get(before.attempt());
        yield attempt == null ? () -> {} : () -> custody.signInEnded(attempt.environment, abandoned.abandoned());
      }
      case Effect.HandSession hand -> {
        Attempt attempt = attempts.get(before.attempt());
        Session session = attempt == null ? null : attempt.session;
        if (session != null) attempt.handed = true;
        yield session == null ? () -> {} : () -> custody.grantSession(attempt.environment, session);
      }
    };
  }

  private void retire(List<Runnable> after) {
    boolean live = !(state.phase().tag() == PhaseTag.IDLE || state.phase().tag() == PhaseTag.FAILED
      || state.phase().tag() == PhaseTag.SIGNED_IN || state.phase().tag() == PhaseTag.REAUTHENTICATED);
    int fallback = SignInPolicy.fallbackOf(state.phase());
    for (Iterator<Map.Entry<Integer, Attempt>> each = attempts.entrySet().iterator(); each.hasNext(); ) {
      Attempt attempt = each.next().getValue();
      if (live && (attempt.number == state.attempt() || attempt.number == fallback)) {
        if (state.serverCode() != ServerCode.HELD_CODE && attempt.serverCode != null) { attempt.serverCode.drop(); attempt.serverCode = null; }
        continue;
      }
      each.remove();
      attempt.cancellation.cancel();
      if (attempt.expiry != null) attempt.expiry.cancel(false);
      if (attempt.serverCode != null) attempt.serverCode.drop();
      attempt.serverCode = null;
      attempt.idToken = null;
      if (attempt.method == Method.GOOGLE_BROWSER) after.add(() -> browser.cancel(attempt.number));
    }
  }

  private void schedule() {
    PhaseTag tag = state.phase().tag();
    Attempt attempt = attempts.get(state.attempt());
    if ((tag != PhaseTag.CODE_SENT && tag != PhaseTag.SECOND_FACTOR) || attempt == null || attempt.expiresAt <= 0 || attempt.expiryAt == attempt.expiresAt) return;
    if (attempt.expiry != null) attempt.expiry.cancel(false);
    attempt.expiryAt = attempt.expiresAt;
    long delay = Math.max(0, attempt.expiresAt - System.currentTimeMillis());
    try { attempt.expiry = timers.schedule(() -> { dispatch(new Event.Expire(attempt.number)); }, delay, TimeUnit.MILLISECONDS); }
    catch (RejectedExecutionException closed) { attempt.expiry = null; }
  }

  private JSObject receipt(Effect.Settled settled) {
    JSObject receipt = new JSObject().put("request", settled.request()).put("attempt", settled.attempt());
    Verdict verdict = settled.verdict();
    Attempt attempt = attempts.get(settled.attempt());
    return switch (verdict.tag()) {
      case CODE_ON_ITS_WAY -> receipt.put("verdict", "code-on-its-way").put("expiresAt", attempt.expiresAt).put("resendAt", attempt.resendAt);
      case FACTOR_ASKED -> receipt.put("verdict", "factor-asked").put("factors", new JSArray(attempt.factors)).put("expiresAt", attempt.expiresAt);
      case SIGNED_IN_AS -> receipt.put("verdict", "signed-in-as").put("credentialId", verdict.credentialId()).put("google", verdict.google().wire);
      case ACCOUNT_CONFIRMED -> receipt.put("verdict", "account-confirmed");
      case TRY_AGAIN -> receipt.put("verdict", "try-again").put("retry", verdict.failure().wire);
      case ENDED -> receipt.put("verdict", "ended").put("problem", verdict.failure().wire);
    };
  }

  private void run(Runnable work) {
    try { worker.execute(work); }
    catch (RejectedExecutionException closed) { return; }
  }

  private SignInRegistration.Environment environment(PluginCall call) {
    if (registration == null) { reject(call, Failure.REJECTED); return null; }
    SignInRegistration.Environment environment = registration.environment(call.getString("environment"));
    if (environment == null) reject(call, Failure.INVALID_INPUT);
    return environment;
  }

  private JSObject account(SignInRegistration.Environment environment) {
    Held held = custody.held(environment);
    if (held == null) return new JSObject().put("signedIn", false);
    Account account = held.account();
    return new JSObject().put("signedIn", true).put("userId", account.userId()).put("organizationId", account.organizationId())
      .put("credentialId", held.credentialId()).put("keyExpiresAt", held.keyExpiresAt());
  }

  private static JSObject readiness(String environment, SignInReadiness.Status status) {
    return new JSObject().put("environment", environment).put("methodsKnown", status.methodsKnown).put("email", status.email)
      .put("sms", status.sms).put("google", status.google).put("googleMode", status.googleMode == GoogleMode.BROWSER ? "browser" : "picker");
  }

  private static void reject(PluginCall call, Failure failure) { reject(call, failure, 0); }

  private static void reject(PluginCall call, Failure failure, long resendAt) {
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
