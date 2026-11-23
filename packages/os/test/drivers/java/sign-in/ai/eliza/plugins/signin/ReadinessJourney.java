// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
package ai.eliza.plugins.signin;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Walks the readiness stories through SignInRegistration and SignInReadiness against a local HTTP cloud; prints one JSON line per observation. */
public final class ReadinessJourney {
  private ReadinessJourney() {}

  private static final String ORIGIN = "https://api.cloud.test";
  private static final String STAGING = "https://staging-api.cloud.test";

  private record Reply(int status, String body) {}

  private interface JsonWork<T> { T get() throws JSONException; }

  private static <T> T json(JsonWork<T> work) {
    try { return work.get(); } catch (JSONException invalid) { throw new IllegalStateException(invalid); }
  }

  private static void emit(String step, Object value) {
    System.out.println(json(() -> new JSONObject().put("step", step).put("value", value == null ? JSONObject.NULL : value)));
  }

  private static Map<String, Object> environment(String name, String api) {
    return Map.of("name", name, "apiOrigin", api, "appLinkHost", "app.cloud.test", "redirectPath", "/auth/" + name);
  }

  private static Map<String, Object> config(String mode, boolean tests, List<Map<String, Object>> environments) {
    Map<String, Object> config = new HashMap<>();
    config.put("clientId", "ai.example.phone");
    config.put("googleMode", mode);
    if (tests) config.put("testEnvironments", true);
    config.put("environments", environments);
    config.put("googleScopes", List.of("openid", "email"));
    config.put("routes", List.of(Map.of("method", "GET", "path", "/api/v1/user")));
    return config;
  }

  private static String refusal(Map<String, Object> config) {
    try {
      SignInRegistration.parse(config);
      return "accepted";
    } catch (SignInRegistration.Refused refused) {
      return "refused";
    }
  }

  private static String configBody(boolean email, boolean sms, boolean google, boolean nativeSignIn, String serverClientId, String environment) {
    return json(() -> new JSONObject().put("clientId", "ai.example.phone").put("environment", environment)
      .put("redirectUri", "https://app.cloud.test/auth/" + environment).put("codeChallengeMethod", "S256").put("credentialTtlMs", 2_592_000_000L)
      .put("methods", new JSONObject().put("email", email).put("sms", sms).put("google", google))
      .put("google", new JSONObject().put("configured", google).put("serverClientId", serverClientId).put("nativeSignIn", nativeSignIn)).toString());
  }

  private static JSONObject legal(String title) {
    return json(() -> new JSONObject().put("title", title).put("revision", "2026-01")
      .put("sections", new JSONArray().put(new JSONObject().put("title", "Scope").put("paragraphs", new JSONArray().put("These words apply.")))));
  }

  private static long probes(List<String> requests, String environment) {
    synchronized (requests) { return requests.stream().filter(r -> r.contains("environment=" + environment + "&")).count(); }
  }

  private static JSONObject status(SignInReadiness.Status s) {
    return json(() -> new JSONObject().put("methodsKnown", s.methodsKnown).put("email", s.email).put("sms", s.sms).put("google", s.google));
  }

  public static void main(String[] args) throws IOException, JSONException {
    emit("registration-valid", refusal(config("picker", false, List.of(environment("production", ORIGIN)))));
    Map<String, Object> noClient = config("picker", false, List.of(environment("production", ORIGIN)));
    noClient.remove("clientId");
    emit("registration-no-client", refusal(noClient));
    emit("registration-test-environment-not-enabled", refusal(config("picker", false, List.of(environment("production", ORIGIN), environment("staging", STAGING)))));
    emit("registration-plain-http", refusal(config("picker", false, List.of(environment("production", "http://api.cloud.test")))));
    emit("registration-no-production", refusal(config("picker", true, List.of(environment("staging", STAGING)))));
    emit("registration-shared-origin", refusal(config("picker", true, List.of(environment("production", ORIGIN), environment("staging", ORIGIN)))));
    emit("registration-hosted-mode", refusal(config("hosted", false, List.of(environment("production", ORIGIN)))));

    AtomicReference<Reply> configReply = new AtomicReference<>();
    AtomicReference<Reply> serviceReply = new AtomicReference<>();
    List<String> requests = new ArrayList<>();
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/", exchange -> {
      String path = exchange.getRequestURI().getPath();
      synchronized (requests) { requests.add(exchange.getRequestURI().toString()); }
      Reply reply = path.equals(SignInReadiness.CONFIG_PATH) ? configReply.get()
        : path.equals(SignInReadiness.SERVICE_PATH) ? serviceReply.get() : new Reply(404, "{\"error\":\"not_found\"}");
      byte[] bytes = reply.body().getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(reply.status(), bytes.length);
      try (OutputStream out = exchange.getResponseBody()) { out.write(bytes); }
    });
    server.start();
    String local = "http://127.0.0.1:" + server.getAddress().getPort();
    List<String> origins = new ArrayList<>();
    SignInReadiness.Http http = url -> {
      String origin = url.startsWith(STAGING) ? STAGING : url.startsWith(ORIGIN) ? ORIGIN : "elsewhere";
      synchronized (origins) { origins.add(origin); }
      if (origin.equals("elsewhere")) throw new IOException("not a registered origin");
      HttpURLConnection connection = (HttpURLConnection) URI.create(local + url.substring(origin.length())).toURL().openConnection();
      try {
        connection.setConnectTimeout(5_000);
        connection.setReadTimeout(5_000);
        int code = connection.getResponseCode();
        try (InputStream in = code >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
          return new SignInReadiness.Response(code, new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
      } finally {
        connection.disconnect();
      }
    };
    try {
      AtomicLong clock = new AtomicLong(1_000_000L);
      Map<String, String> preferences = new HashMap<>();
      SignInReadiness.Store store = new SignInReadiness.Store() {
        @Override public String get(String key) { return preferences.get(key); }
        @Override public void put(String key, String value) { preferences.put(key, value); }
      };
      List<JSONObject> announced = new ArrayList<>();
      SignInRegistration picker = SignInRegistration.parse(config("picker", true, List.of(environment("production", ORIGIN), environment("staging", STAGING))));
      SignInReadiness readiness = new SignInReadiness(picker, http, store, Runnable::run, clock::get,
        () -> new ReadinessPolicy.DeviceFacts(ReadinessPolicy.GoogleMode.PICKER, false, false),
        (environment, s) -> announced.add(json(() -> status(s).put("environment", environment))));
      List<JSONObject> served = new ArrayList<>();

      configReply.set(new Reply(200, configBody(true, false, true, true, "server.apps.example", "production")));
      readiness.load();
      emit("load-probes", new JSONArray().put(probes(requests, "production")).put(probes(requests, "staging")));
      emit("load-query", requests.isEmpty() ? null : requests.get(0));
      emit("first-answer-announced", announced.size());

      requests.clear();
      clock.addAndGet(1_000);
      readiness.status("production", false, s -> served.add(status(s)));
      emit("fresh-served", served.get(served.size() - 1));
      emit("fresh-probes", probes(requests, "production"));

      clock.addAndGet(30_000);
      readiness.status("production", false, s -> served.add(status(s)));
      emit("recheck-served-count", served.size());
      emit("recheck-probes", probes(requests, "production"));
      emit("unchanged-announced", announced.size());

      configReply.set(new Reply(503, "{\"error\":\"service_unavailable\"}"));
      clock.addAndGet(31_000);
      readiness.status("production", false, s -> served.add(status(s)));
      emit("no-reading-probes", probes(requests, "production"));
      emit("no-reading-keeps", served.get(served.size() - 1));
      readiness.status("production", false, s -> served.add(status(s)));
      emit("no-reading-keeps-after", served.get(served.size() - 1));
      emit("no-reading-announced", announced.size());

      configReply.set(new Reply(200, configBody(true, true, true, true, "server.apps.example", "production")));
      clock.addAndGet(31_000);
      readiness.status("production", false, s -> served.add(status(s)));
      emit("changed-announced", announced.isEmpty() ? null : announced.get(announced.size() - 1));
      emit("changed-announced-count", announced.size());

      long before = probes(requests, "production");
      clock.addAndGet(3 * 3_600_000L);
      readiness.status("production", true, s -> served.add(status(s)));
      readiness.resume(true);
      emit("complete-probes", probes(requests, "production") - before);

      clock.addAndGet(3 * 3_600_000L);
      before = probes(requests, "production");
      readiness.status("production", false, s -> served.add(status(s)));
      emit("expired-probes", probes(requests, "production") - before);

      configReply.set(new Reply(400, "{\"error\":\"invalid_client\",\"errorDescription\":\"Invalid client.\",\"retryable\":false}"));
      clock.addAndGet(ReadinessPolicy.READY_TTL_MS);
      readiness.status("production", false, s -> served.add(status(s)));
      emit("refused-client", served.get(served.size() - 1));
      emit("refused-client-announced", announced.get(announced.size() - 1));

      emit("unknown-environment", readiness.status("preview", false, s -> served.add(status(s))));

      configReply.set(new Reply(200, configBody(true, false, true, true, "server.apps.example", "staging")));
      SignInReadiness resumed = new SignInReadiness(picker, http, store, Runnable::run, clock::get,
        () -> new ReadinessPolicy.DeviceFacts(ReadinessPolicy.GoogleMode.PICKER, false, false), (environment, s) -> {});
      int total = requests.size();
      clock.addAndGet(700_000);
      resumed.resume(false);
      emit("resume-without-screen-probes", requests.size() - total);
      resumed.status("staging", false, s -> served.add(status(s)));
      emit("staging-served", served.get(served.size() - 1));
      before = probes(requests, "staging");
      clock.addAndGet(31_000);
      resumed.resume(false);
      emit("resume-after-screen-probes", probes(requests, "staging") - before);

      AtomicReference<Boolean> appLink = new AtomicReference<>(false);
      AtomicReference<List<String>> browsers = new AtomicReference<>(List.of("ai.example.phone", "browser.full"));
      SignInRegistration browserMode = SignInRegistration.parse(config("browser", false, List.of(environment("production", ORIGIN))));
      SignInReadiness browser = new SignInReadiness(browserMode, http, new SignInReadiness.Store() {
        private final Map<String, String> held = new HashMap<>();
        @Override public String get(String key) { return held.get(key); }
        @Override public void put(String key, String value) { held.put(key, value); }
      }, Runnable::run, clock::get, () -> new ReadinessPolicy.DeviceFacts(ReadinessPolicy.GoogleMode.PICKER, appLink.get(),
        BrowserReturnPolicy.externalBrowser(null, browsers.get(), "ai.example.phone") != null), (environment, s) -> {});
      configReply.set(new Reply(200, configBody(true, true, true, false, "", "production")));
      browser.status("production", false, s -> served.add(status(s)));
      emit("browser-unverified", served.get(served.size() - 1));
      appLink.set(true);
      browser.status("production", false, s -> served.add(status(s)));
      emit("browser-verified", served.get(served.size() - 1));
      before = probes(requests, "production");
      browsers.set(List.of("ai.example.phone", BrowserReturnPolicy.WEBVIEW_SHELL));
      browser.status("production", false, s -> served.add(status(s)));
      emit("browser-shell-only", served.get(served.size() - 1));
      browsers.set(List.of(BrowserReturnPolicy.WEBVIEW_SHELL, "browser.without.custom.tabs"));
      browser.status("production", false, s -> served.add(status(s)));
      emit("browser-full", served.get(served.size() - 1));
      emit("browser-change-probes", probes(requests, "production") - before);
      emit("browser-choice", new JSONArray(List.of(
        String.valueOf(BrowserReturnPolicy.externalBrowser("browser.default", List.of("browser.other", "browser.default"), "ai.example.phone")),
        String.valueOf(BrowserReturnPolicy.externalBrowser(BrowserReturnPolicy.WEBVIEW_SHELL, List.of(BrowserReturnPolicy.WEBVIEW_SHELL, "browser.other"), "ai.example.phone")),
        String.valueOf(BrowserReturnPolicy.externalBrowser("ai.example.phone", List.of("ai.example.phone", BrowserReturnPolicy.WEBVIEW_SHELL), "ai.example.phone")))));

      List<String> outcomes = new ArrayList<>();
      String document = new JSONObject().put("success", true).put("version", 1)
        .put("service", new JSONObject().put("name", "Example Cloud").put("terms", legal("Terms")).put("privacy", legal("Privacy"))).toString();
      serviceReply.set(new Reply(200, document));
      origins.clear();
      readiness.service("staging", s -> {
        outcomes.add(s.outcome.name());
        emit("service-body", s.body == null ? null : json(() -> new JSONObject(s.body)));
      });
      emit("service-origins", new JSONArray(origins));
      serviceReply.set(new Reply(200, new JSONObject(document).put("service", new JSONObject().put("name", "Example Cloud").put("terms", "Terms").put("privacy", "Privacy")).toString()));
      readiness.service("production", s -> outcomes.add(s.outcome.name()));
      serviceReply.set(new Reply(500, "{\"error\":\"internal\"}"));
      readiness.service("production", s -> outcomes.add(s.outcome.name()));
      readiness.service("preview", s -> outcomes.add(s.outcome.name()));
      emit("service-outcomes", new JSONArray(outcomes));
      emit("service-expected-document", new JSONObject(document));
    } finally {
      server.stop(0);
    }
  }
}
