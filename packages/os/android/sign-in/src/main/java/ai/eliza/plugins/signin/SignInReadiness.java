// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.ReadinessPolicy.Answer;
import ai.eliza.plugins.signin.ReadinessPolicy.CloudMethods;
import ai.eliza.plugins.signin.ReadinessPolicy.CloudReading;
import ai.eliza.plugins.signin.ReadinessPolicy.DeviceFacts;
import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import ai.eliza.plugins.signin.ReadinessPolicy.Readiness;
import ai.eliza.plugins.signin.ReadinessPolicy.ServiceOutcome;
import ai.eliza.plugins.signin.ReadinessPolicy.SignInMethod;
import ai.eliza.plugins.signin.ReadinessPolicy.StatusPlan;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The per-environment readiness cache of the sign-in plugin: it asks {@link ReadinessPolicy} whether to
 * measure, runs the one probe, folds it into the answer and announces a change. It holds no secret:
 * the answer lives in memory and in plain preferences. Every request is short; callers never block.
 */
public final class SignInReadiness {
  public static final String CONFIG_PATH = "/api/v1/app-auth/mobile/config";
  public static final String SERVICE_PATH = "/api/public/service";

  /** One HTTP read with a short fixed timeout; an {@link IOException} is "no usable answer". */
  public interface Http {
    Response get(String url) throws IOException;
  }

  public static final class Response {
    public final int status;
    public final String body;
    public Response(int status, String body) { this.status = status; this.body = body; }
  }

  /** Plain, non-secret preferences. */
  public interface Store {
    String get(String key);
    void put(String key, String value);
  }

  /** The methods the screen may show, computed from the answer and Android's own facts at the moment of asking. */
  public static final class Status {
    public final boolean methodsKnown, email, sms, google;
    public final GoogleMode googleMode;
    Status(Readiness readiness, DeviceFacts facts) {
      methodsKnown = readiness.tag == ReadinessPolicy.ReadinessTag.KNOWN;
      email = ReadinessPolicy.offered(readiness, facts, SignInMethod.EMAIL_CODE);
      sms = ReadinessPolicy.offered(readiness, facts, SignInMethod.SMS_CODE);
      google = ReadinessPolicy.offered(readiness, facts, SignInMethod.google(facts.googleMode));
      googleMode = facts.googleMode;
    }
    @Override public boolean equals(Object other) {
      return other instanceof Status s && methodsKnown == s.methodsKnown && email == s.email && sms == s.sms && google == s.google;
    }
    @Override public int hashCode() { return (methodsKnown ? 1 : 0) | (email ? 2 : 0) | (sms ? 4 : 0) | (google ? 8 : 0); }
  }

  /** The service document exactly as received ({@code body}), or why there is none. */
  public static final class Service {
    public final ServiceOutcome outcome;
    public final String body;
    Service(ServiceOutcome outcome, String body) { this.outcome = outcome; this.body = body; }
  }

  private final SignInRegistration registration;
  private final Http http;
  private final Store store;
  private final Executor executor;
  private final LongSupplier clock;
  private final Supplier<DeviceFacts> facts;
  private final Announcer announcer;
  private final Object lock = new Object();
  private final Map<String, Answer> answers = new HashMap<>();
  private final Map<String, List<Consumer<Status>>> probing = new HashMap<>();
  private long statusAskedAt;

  /** Told {@code signInReadinessChanged} when a measurement changes an earlier answer; never the first. */
  public interface Announcer {
    void changed(String environment, Status status);
  }

  public SignInReadiness(SignInRegistration registration, Http http, Store store, Executor executor, LongSupplier clock,
      Supplier<DeviceFacts> facts, Announcer announcer) {
    this.registration = registration; this.http = http; this.store = store; this.executor = executor;
    this.clock = clock; this.facts = facts; this.announcer = announcer;
  }

  /** Plugin load: warms every registered environment's answer when it is not fresh or its growing wait ended. */
  public void load() {
    long now = clock.getAsLong();
    for (SignInRegistration.Environment environment : registration.environments()) {
      if (ReadinessPolicy.onLoad(answer(environment.name), registration.googleMode, now)) measure(environment, null);
    }
  }

  /** App resume: measures only for a recent sign-in screen or an attempt in progress. */
  public void resume(boolean attemptActive) {
    long now = clock.getAsLong();
    long asked;
    synchronized (lock) { asked = statusAskedAt; }
    for (SignInRegistration.Environment environment : registration.environments()) {
      if (ReadinessPolicy.onResume(answer(environment.name), registration.googleMode, now, asked, attemptActive)) measure(environment, null);
    }
  }

  /**
   * The sign-in screen asks. A fresh answer is served at once and, if a method is still not ready after
   * 30 s, measured behind it; otherwise {@code done} waits for the probe. Returns false, answering
   * nothing, when the environment is not registered.
   */
  public boolean status(String environmentName, boolean retry, Consumer<Status> done) {
    SignInRegistration.Environment environment = registration.environment(environmentName);
    if (environment == null) return false;
    long now = clock.getAsLong();
    synchronized (lock) { statusAskedAt = now; }
    Answer cached = answer(environment.name);
    StatusPlan plan = ReadinessPolicy.onStatus(cached, registration.googleMode, now, retry);
    if (plan.serveNow) done.accept(new Status(cached.readiness, device()));
    measure(environment, plan.serveNow ? null : done, plan.measure);
    return true;
  }

  /** The cloud refused this client on another route: that is an answer that no method is ready. */
  public void clientRefused(String environmentName) {
    SignInRegistration.Environment environment = registration.environment(environmentName);
    if (environment != null) fold(environment, CloudReading.CLIENT_UNREGISTERED);
  }

  /** The service document from the registered environment's own API origin, as received. */
  public void service(String environmentName, Consumer<Service> done) {
    SignInRegistration.Environment environment = registration.environment(environmentName);
    if (environment == null) {
      done.accept(new Service(ReadinessPolicy.serviceOutcome(false, 0, false), null));
      return;
    }
    try {
      executor.execute(() -> {
        Response response;
        try { response = http.get(environment.apiOrigin + SERVICE_PATH); } catch (IOException | RuntimeException unavailable) { response = null; }
        boolean wellFormed = response != null && serviceWellFormed(response.body);
        ServiceOutcome outcome = ReadinessPolicy.serviceOutcome(true, response == null ? 0 : response.status, wellFormed);
        done.accept(new Service(outcome, outcome == ServiceOutcome.SERVICE_SHOWN ? response.body : null));
      });
    } catch (RejectedExecutionException closed) {
      done.accept(new Service(ServiceOutcome.SERVICE_UNAVAILABLE, null));
    }
  }

  /** Android's own facts, read when an answer is shown and never cached; the mode is the host's registered one. */
  private DeviceFacts device() {
    DeviceFacts read = facts.get();
    return new DeviceFacts(registration.googleMode, read.appLinkVerified, read.externalBrowser);
  }

  private Answer answer(String environment) {
    synchronized (lock) {
      Answer held = answers.get(environment);
      if (held == null) {
        held = parse(store.get(key(environment)));
        answers.put(environment, held);
      }
      return held;
    }
  }

  private void measure(SignInRegistration.Environment environment, Consumer<Status> waiter) { measure(environment, waiter, true); }

  private void measure(SignInRegistration.Environment environment, Consumer<Status> waiter, boolean run) {
    synchronized (lock) {
      List<Consumer<Status>> waiting = probing.get(environment.name);
      if (waiting != null) { if (waiter != null) waiting.add(waiter); return; }
      if (!run) return;
      waiting = new ArrayList<>();
      if (waiter != null) waiting.add(waiter);
      probing.put(environment.name, waiting);
    }
    try {
      executor.execute(() -> {
        try { fold(environment, probe(environment)); }
        finally {
          List<Consumer<Status>> waiting;
          synchronized (lock) { waiting = probing.remove(environment.name); }
          Status status = new Status(answer(environment.name).readiness, device());
          for (Consumer<Status> each : waiting) each.accept(status);
        }
      });
    } catch (RejectedExecutionException closed) {
      List<Consumer<Status>> waiting;
      synchronized (lock) { waiting = probing.remove(environment.name); }
      Status status = new Status(answer(environment.name).readiness, device());
      for (Consumer<Status> each : waiting) each.accept(status);
    }
  }

  private void fold(SignInRegistration.Environment environment, CloudReading reading) {
    Answer previous, next;
    synchronized (lock) {
      previous = answer(environment.name);
      next = ReadinessPolicy.measureAnswer(previous, reading, registration.googleMode, clock.getAsLong());
      answers.put(environment.name, next);
    }
    store.put(key(environment.name), serialize(next));
    if (ReadinessPolicy.announces(previous.readiness, next.readiness)) announcer.changed(environment.name, new Status(next.readiness, device()));
  }

  /** One read of the cloud's native client configuration for this client id, environment and redirect. */
  private CloudReading probe(SignInRegistration.Environment environment) {
    String url = environment.apiOrigin + CONFIG_PATH + "?clientId=" + enc(registration.clientId)
      + "&environment=" + enc(environment.name) + "&redirectUri=" + enc(environment.redirectUri);
    Response response;
    try { response = http.get(url); } catch (IOException | RuntimeException none) { return CloudReading.NO_READING; }
    return reading(response, registration.clientId, environment);
  }

  static CloudReading reading(Response response, String clientId, SignInRegistration.Environment environment) {
    int status = response.status;
    if (status >= 500 || status == 408 || status == 429) return CloudReading.NO_READING;
    JSONObject body = object(response.body);
    if (body == null) return CloudReading.NO_READING;
    if (status == 400 || status == 403) {
      String error = body.optString("error", "");
      return error.equals("invalid_client") || error.equals("client_disabled") || error.equals("redirect_mismatch")
        ? CloudReading.CLIENT_UNREGISTERED : CloudReading.NO_READING;
    }
    if (status != 200) return CloudReading.NO_READING;
    boolean bound = clientId.equals(body.optString("clientId", null)) && environment.name.equals(body.optString("environment", null))
      && environment.redirectUri.equals(body.optString("redirectUri", null)) && "S256".equals(body.optString("codeChallengeMethod", null));
    if (!bound) return CloudReading.NO_READING;
    JSONObject methods = body.optJSONObject("methods"), google = body.optJSONObject("google");
    if (methods == null || google == null) return CloudReading.NO_READING;
    String serverClientId = google.optString("serverClientId", "");
    return CloudReading.methodsRead(new CloudMethods(
      methods.optBoolean("email", false), methods.optBoolean("sms", false), methods.optBoolean("google", false) && google.optBoolean("configured", false),
      google.optBoolean("nativeSignIn", false), !serverClientId.isBlank()));
  }

  /** {success: true, version: 1, service: {name, terms, privacy}} with text in all three. */
  static boolean serviceWellFormed(String body) {
    JSONObject document = object(body);
    if (document == null || !document.optBoolean("success", false) || document.optInt("version", 0) != 1) return false;
    JSONObject service = document.optJSONObject("service");
    return service != null && text(service, "name") && text(service, "terms") && text(service, "privacy");
  }

  private static boolean text(JSONObject source, String key) {
    return source.opt(key) instanceof String s && !s.isBlank();
  }

  private static JSONObject object(String body) {
    try { return body == null ? null : new JSONObject(body); } catch (JSONException invalid) { return null; }
  }

  private String key(String environment) { return "signin-readiness:" + registration.googleMode.name().toLowerCase(java.util.Locale.ROOT) + ":" + environment; }

  private static String enc(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }

  static String serialize(Answer a) {
    CloudMethods m = a.readiness.methods;
    return "v1|" + a.readiness.tag.name() + "|" + (m == null ? "-----" : bits(m)) + "|" + a.until + "|" + a.recheckAt + "|" + a.passiveAt + "|" + a.unchanged;
  }

  private static String bits(CloudMethods m) {
    return (m.email ? "1" : "0") + (m.sms ? "1" : "0") + (m.google ? "1" : "0") + (m.nativeSignIn ? "1" : "0") + (m.serverClientId ? "1" : "0");
  }

  /** A stored answer that does not parse is no answer: it is measured again. */
  static Answer parse(String value) {
    if (value == null) return ReadinessPolicy.NO_ANSWER;
    String[] p = value.split("\\|", -1);
    try {
      if (p.length != 7 || !p[0].equals("v1")) return ReadinessPolicy.NO_ANSWER;
      ReadinessPolicy.ReadinessTag tag = ReadinessPolicy.ReadinessTag.valueOf(p[1]);
      Readiness readiness = tag == ReadinessPolicy.ReadinessTag.KNOWN
        ? Readiness.known(new CloudMethods(p[2].charAt(0) == '1', p[2].charAt(1) == '1', p[2].charAt(2) == '1', p[2].charAt(3) == '1', p[2].charAt(4) == '1'))
        : tag == ReadinessPolicy.ReadinessTag.UNKNOWN ? Readiness.UNKNOWN : Readiness.NOT_MEASURED;
      if (tag == ReadinessPolicy.ReadinessTag.KNOWN && !p[2].matches("[01]{5}")) return ReadinessPolicy.NO_ANSWER;
      return new Answer(readiness, Long.parseLong(p[3]), Long.parseLong(p[4]), Long.parseLong(p[5]), Integer.parseInt(p[6]));
    } catch (IllegalArgumentException | IndexOutOfBoundsException invalid) {
      return ReadinessPolicy.NO_ANSWER;
    }
  }
}
