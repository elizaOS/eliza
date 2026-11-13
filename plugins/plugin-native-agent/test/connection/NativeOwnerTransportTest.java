package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.connection.NativeAppReadPolicy;
import ai.eliza.plugins.agent.connection.NativeOwnerTransport;
import com.sun.net.httpserver.HttpServer;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/** Real loopback HTTP exchange through the shared production enrollment/request algorithm. */
public final class NativeOwnerTransportTest {
  private static final java.util.concurrent.atomic.AtomicInteger assertions = new java.util.concurrent.atomic.AtomicInteger();
  private static void check(boolean value, String name) {
    assertions.incrementAndGet();
    if (!value) throw new AssertionError(name);
  }
  private interface Action { void run() throws Exception; }
  private static void refused(Action action, String name) throws Exception {
    try { action.run(); } catch (IllegalStateException | IllegalArgumentException expected) {
      check(true, name); return;
    }
    throw new AssertionError(name);
  }

  private static final class Fixture implements AutoCloseable, NativeOwnerTransport.Host {
    final HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    final Object enrollment = new Object();
    final List<String> requests = java.util.Collections.synchronizedList(new ArrayList<>());
    volatile String root = "private-root", token = "private-owner", identity = "owner-id";
    volatile String responseRole = "OWNER", responseIdentity = identity, responseSession = token;
    volatile long clock = 1_000_000, expiry = clock + 60_000;
    volatile NativeOwnerTransport.Session cache;
    volatile int published, invalidated, dataStatus = 200;
    volatile boolean changeRootAfterData, changeOwnerAfterData;
    volatile String dataAuth, dataClient, dataBody, dataMethod;
    volatile Throwable handlerFailure;

    Fixture() throws Exception {
      server.createContext("/", exchange -> {
        try {
        String path = exchange.getRequestURI().getPath();
        requests.add(exchange.getRequestMethod() + " " + path);
        String auth = exchange.getRequestHeaders().getFirst("Authorization");
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        JSONObject value;
        int status = 200;
        if (path.equals("/api/auth/status")) {
          NativeOwnerTransportTest.check(("Bearer " + root).equals(auth), "requirements uses native root");
          value = new JSONObject().put("authenticated", true).put("instanceId", "instance");
        } else if (path.equals("/api/auth/pair-code")) {
          NativeOwnerTransportTest.check(("Bearer " + root).equals(auth), "pair-code uses native root");
          value = new JSONObject().put("code", "code");
        } else if (path.equals("/api/auth/pair")) {
          JSONObject submitted = new JSONObject(body);
          NativeOwnerTransportTest.check("POST".equals(exchange.getRequestMethod()) && "code".equals(submitted.getString("code"))
              && "instance".equals(submitted.getString("instanceId")), "pair exact body and method");
          NativeOwnerTransportTest.check(("Bearer " + root).equals(auth), "pair uses native root");
          value = new JSONObject().put("access", "owner").put("instanceId", "instance")
              .put("token", token).put("identityId", identity);
        } else if (path.equals("/api/auth/me")) {
          NativeOwnerTransportTest.check(("Bearer " + token).equals(auth), "owner readback uses native owner");
          value = new JSONObject().put("access", new JSONObject().put("role", responseRole))
              .put("identity", new JSONObject().put("id", responseIdentity))
              .put("session", new JSONObject().put("id", responseSession).put("expiresAt", expiry));
        } else {
          dataAuth = auth;
          dataClient = exchange.getRequestHeaders().getFirst("X-ElizaOS-Client-Id");
          dataBody = body;
          dataMethod = exchange.getRequestMethod();
          value = new JSONObject().put("data", "actual-response");
          status = dataStatus;
          if (changeRootAfterData) root = "new-root";
          if (changeOwnerAfterData) cache = new NativeOwnerTransport.Session(root, "new-owner", "new-id", expiry);
        }
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
        } catch (Throwable failure) {
          handlerFailure = failure;
          exchange.sendResponseHeaders(500, -1);
        } finally { exchange.close(); }
      });
      server.start();
    }
    public Object enrollmentLock() { return enrollment; }
    public String root() { return root; }
    public void check(String admittedRoot) {
      if (admittedRoot == null || admittedRoot.isEmpty() || !admittedRoot.equals(root))
        throw new IllegalStateException("retired request");
    }
    public NativeOwnerTransport.Session cached(String admittedRoot, long minimumExpiry) {
      return cache != null && cache.root.equals(admittedRoot) && cache.expiresAt > minimumExpiry ? cache : null;
    }
    public void publish(NativeOwnerTransport.Session session) { check(session.root); cache = session; published++; }
    public void invalidate(NativeOwnerTransport.Session session) {
      if (cache == session) { cache = null; invalidated++; }
    }
    public long now() { return clock; }
    public JSONObject exchange(String path, String method, String body, String bearer, JSONObject headers) throws Exception {
      HttpURLConnection connection = (HttpURLConnection) new URL("http://127.0.0.1:" + server.getAddress().getPort() + path).openConnection();
      connection.setConnectTimeout(2000); connection.setReadTimeout(2000);
      connection.setRequestMethod(method);
      connection.setRequestProperty("Authorization", "Bearer " + bearer);
      if (headers != null) for (String key : headers.keySet()) connection.setRequestProperty(key, headers.getString(key));
      if (body != null) {
        connection.setDoOutput(true);
        connection.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
      }
      try {
        int status = connection.getResponseCode();
        if (handlerFailure != null) throw new AssertionError("HTTP fixture failed", handlerFailure);
        try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
          return new JSONObject().put("status", status)
              .put("body", new String(input.readAllBytes(), StandardCharsets.UTF_8)).put("bodyBase64", "raw-body");
        }
      } finally { connection.disconnect(); }
    }
    public void close() { server.stop(0); }
  }

  public static void main(String[] args) throws Exception {
    for (String path : new String[] {"/api/auth/status", "/api/auth/me", "/api/agents", "/api/status",
        "/api/first-run/status", "/api/first-run/options", "/api/config", "/api/stream/settings",
        "/api/wallet/config", "/api/wallet/addresses", "/api/wallet/balances", "/api/wallet/nfts",
        "/api/plugins", "/api/skills", "/api/character", "/api/workbench/overview",
        "/api/update/status", "/api/update/status?force=true", "/api/agent/events",
        "/api/agent/events?after=7&limit=300&runId=run-1&fromSeq=2"}) {
      check(NativeAppReadPolicy.allowed(path, "GET", null), "common read " + path);
      for (String method : new String[] {"POST", "PUT", "DELETE", "PATCH", "get"})
        check(!NativeAppReadPolicy.allowed(path, method, null), "not read method " + method);
      check(!NativeAppReadPolicy.allowed(path, "GET", ""), "read body refused");
    }
    for (String path : new String[] {"/api/auth/pair-code", "/api/auth/pair", "/api/auth/me?",
        "/api/auth/me?extra=1", "/api/config?", "/api/config/", "/api/config/../auth/me", "/api//config",
        "/api/%63onfig", "/api/config#fragment", "/api/config\\suffix", "/api/config\r\nheader",
        "https://host/api/config", "//host/api/config", "/api/wallet/export", "/api/plugins/install",
        "/api/update/status?force=false", "/api/update/status?force=true&force=true",
        "/api/update/status?%66orce=true", "/api/agent/events?after=1&after=2",
        "/api/agent/events?unknown=1", "/api/agent/events?limit=3&%6cimit=4", "/api/agent/events?limit=%"})
      check(!NativeAppReadPolicy.allowed(path, "GET", null), "unsafe or effect route " + path);

    try (Fixture host = new Fixture()) {
      JSONObject requirements = NativeOwnerTransport.requirements(host);
      check(requirements.getInt("status") == 200 && host.requests.size() == 1 && host.published == 0,
          "requirements reads actual status without enrollment");
      JSONObject result = NativeOwnerTransport.request(host, "/api/config", "GET", null, "owner-id",
          new JSONObject().put("Authorization", "Bearer renderer-token").put("Host", "attacker")
              .put("X-ElizaOS-Client-Id", "client.1"));
      check(result.getString("body").contains("actual-response"), "actual response preserved");
      check(host.published == 1 && "Bearer private-owner".equals(host.dataAuth)
          && "client.1".equals(host.dataClient), "native owner bearer, allowed header only");
      int requests = host.requests.size();
      NativeOwnerTransport.request(host, "/api/config", "GET", null, "owner-id", null);
      check(host.requests.size() == requests + 1 && host.published == 1, "valid owner cache reused");
      requests = host.requests.size();
      check(NativeOwnerTransport.request(host, "/api/config", "GET", null, "wrong-owner", null).getInt("status") == 409
          && host.requests.size() == requests, "wrong owner rejects before data dispatch");
      JSONObject who = NativeOwnerTransport.request(host, "/api/auth/me", "GET", null, null, null);
      check("native-owned-session".equals(new JSONObject(who.getString("body")).getJSONObject("session").getString("id"))
          && !who.toString().contains("private-owner") && !who.has("bodyBase64"), "session bearer is redacted");
      JSONObject queriedWho = NativeOwnerTransport.request(host, "/api/auth/me?probe=1", "GET", null, null, null);
      check(!queriedWho.toString().contains("private-owner") && !queriedWho.has("bodyBase64"), "projection also covers query form");
      NativeOwnerTransport.request(host, "/api/effect", "POST", "{\"exact\":true}", "owner-id", null);
      check("POST".equals(host.dataMethod) && "{\"exact\":true}".equals(host.dataBody), "admitted effect body unchanged");
      requests = host.requests.size();
      refused(() -> NativeOwnerTransport.request(host, "/api/config", "GET", null, null,
          new JSONObject().put("X-ElizaOS-Client-Id", "bad\r\nvalue")), "header injection refused");
      check(host.requests.size() == requests, "invalid header never dispatches");
      host.dataStatus = 401;
      NativeOwnerTransport.request(host, "/api/config", "GET", null, null, null);
      check(host.cache == null && host.invalidated == 1, "401 clears exact cached owner");
    }
    for (String invalid : new String[] {"role", "identity", "session", "expiry", "token", "empty-identity"}) {
      try (Fixture host = new Fixture()) {
        if (invalid.equals("role")) host.responseRole = "VIEWER";
        if (invalid.equals("identity")) host.responseIdentity = "wrong-owner";
        if (invalid.equals("session")) host.responseSession = "wrong-token";
        if (invalid.equals("expiry")) host.expiry = host.clock;
        if (invalid.equals("token")) host.token = host.responseSession = "";
        if (invalid.equals("empty-identity")) host.identity = host.responseIdentity = "";
        refused(() -> NativeOwnerTransport.enroll(host), "unverified owner refused: " + invalid);
        check(host.published == 0, "invalid owner never cached");
      }
    }
    try (Fixture host = new Fixture()) {
      NativeOwnerTransport.enroll(host);
      host.changeRootAfterData = true;
      refused(() -> NativeOwnerTransport.request(host, "/api/config", "GET", null, null, null), "late response retired after root change");
    }
    try (Fixture host = new Fixture()) {
      NativeOwnerTransport.enroll(host);
      host.dataStatus = 401; host.changeOwnerAfterData = true;
      NativeOwnerTransport.request(host, "/api/config", "GET", null, null, null);
      check(host.cache != null && "new-id".equals(host.cache.identity), "stale 401 cannot clear newer owner cache");
    }
    System.out.println("PASS native owner transport: " + assertions.get() + " checks with real loopback HTTP");
  }
}
