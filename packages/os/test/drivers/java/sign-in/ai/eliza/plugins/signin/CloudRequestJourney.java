// spec/os/signIn/cloudRequests.md, "A session-only route is sent only with a live account session, never with the device key"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A 401 goes to the credential with its reason and is not retried"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CloudRequests.Answered;
import ai.eliza.plugins.signin.CloudRequests.Custody;
import ai.eliza.plugins.signin.CloudRequests.Failed;
import ai.eliza.plugins.signin.CloudRequests.Outcome;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public final class CloudRequestJourney {
  private static final Account ACCOUNT = new Account("user-1", "org-1");
  private static final String KEY = "eliza_mobile_cred-1";
  private static final int BIG = 9 << 20;
  private static final String TABLE = "[{\"prefixes\":[\"/api/v1\"],\"id\":\"[A-Za-z0-9_-]{1,128}\",\"routes\":["
    + "{\"method\":\"GET\",\"path\":\"/api/v1/user\"},"
    + "{\"method\":\"GET\",\"path\":\"/api/v1/models\"},"
    + "{\"method\":\"POST\",\"path\":\"/api/v1/maps/geocode\",\"maxBodyBytes\":4096},"
    + "{\"method\":\"POST\",\"path\":\"/api/v1/subscriptions/cancel\",\"maxBodyBytes\":4096},"
    + "{\"method\":\"DELETE\",\"path\":\"/api/v1/eliza/google/calendar/events/{eventId}\"},"
    + "{\"method\":\"GET\",\"path\":\"/api/v1/eliza/google/calendar/events/{eventId}\"},"
    + "{\"method\":\"GET\",\"path\":\"/api/v1/eliza/google/gmail/inbox-v1/attachment\",\"query\":[{\"key\":\"size\",\"accepts\":{\"kind\":\"any\"}}]},"
    + "{\"method\":\"GET\",\"path\":\"/api/v1/billing/invoices/{invoiceId}\"}]}]";

  private record Seen(String line, String authorization, Map<String, String> headers, byte[] body) {}

  private static final class FakeCloud {
    final List<Seen> seen = new CopyOnWriteArrayList<>();
    final HttpServer server;

    FakeCloud() throws IOException {
      server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
      server.setExecutor(Executors.newCachedThreadPool());
      server.createContext("/", this::handle);
      server.start();
    }

    String origin() { return "http://127.0.0.1:" + server.getAddress().getPort(); }

    long count(String line) { return seen.stream().filter(s -> s.line().equals(line)).count(); }

    Seen last(String line) { return seen.stream().filter(s -> s.line().equals(line)).reduce((a, b) -> b).orElse(null); }

    private void handle(HttpExchange x) throws IOException {
      String path = x.getRequestURI().getPath(), query = x.getRequestURI().getRawQuery();
      Map<String, String> headers = new TreeMap<>();
      for (String name : List.of("If-Match", "If-None-Match", "Idempotency-Key", "Content-Type", "Cookie")) {
        String value = x.getRequestHeaders().getFirst(name);
        if (value != null) headers.put(name, value);
      }
      Seen request = new Seen(x.getRequestMethod() + " " + path, x.getRequestHeaders().getFirst("Authorization"), headers, x.getRequestBody().readAllBytes());
      seen.add(request);
      String bearer = request.authorization() == null ? "" : request.authorization();
      try {
        switch (request.line()) {
          case "GET /api/v1/user" -> {
            if (bearer.equals("Bearer " + KEY + "-revoked")) json(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_revoked\"}");
            else json(x, 200, "{\"success\":true,\"data\":{\"id\":\"user-1\",\"organization_id\":\"org-1\"}}");
          }
          case "GET /api/v1/models" -> json(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_expired\"}");
          case "POST /api/v1/maps/geocode" -> json(x, 200, "{\"results\":[]}");
          case "POST /api/v1/subscriptions/cancel" -> json(x, bearer.equals("Bearer access-1") ? 202 : 401, "{\"status\":\"pending\"}");
          case "DELETE /api/v1/eliza/google/calendar/events/e1" -> {
            x.getResponseHeaders().set("ETag", "\"8\"");
            json(x, "\"7\"".equals(headers.get("If-Match")) ? 200 : 412, "{\"deleted\":\"e1\"}");
          }
          case "GET /api/v1/eliza/google/calendar/events/e1" -> {
            x.getResponseHeaders().set("ETag", "\"8\"");
            if ("\"8\"".equals(headers.get("If-None-Match"))) { x.sendResponseHeaders(304, -1); x.close(); }
            else json(x, 200, "{\"id\":\"e1\"}");
          }
          case "GET /api/v1/eliza/google/gmail/inbox-v1/attachment" -> attachment(x, query);
          case "GET /api/v1/billing/invoices/inv1" -> reply(x, 200, "application/pdf", everyByte());
          default -> json(x, 404, "{\"error\":\"not_found\"}");
        }
      } catch (IOException peerClosed) {
        x.close();
      }
    }

    private static void attachment(HttpExchange x, String query) throws IOException {
      switch (query) {
        case "size=big" -> reply(x, 200, "application/octet-stream", pattern(BIG));
        case "size=declared-huge" -> {
          x.getResponseHeaders().set("Content-Type", "application/octet-stream");
          x.sendResponseHeaders(200, CloudRequestPolicy.REPLY_LIMIT + 1);
          x.close();
        }
        case "size=streamed-huge" -> {
          x.getResponseHeaders().set("Content-Type", "application/octet-stream");
          x.sendResponseHeaders(200, 0);
          byte[] block = pattern(1 << 20);
          try (OutputStream out = x.getResponseBody()) { for (long sent = 0; sent <= CloudRequestPolicy.REPLY_LIMIT; sent += block.length) out.write(block); }
        }
        default -> json(x, 400, "{\"error\":\"bad_request\"}");
      }
    }

    private static void json(HttpExchange x, int status, String body) throws IOException { reply(x, status, "application/json", body.getBytes(StandardCharsets.UTF_8)); }

    private static void reply(HttpExchange x, int status, String type, byte[] body) throws IOException {
      x.getResponseHeaders().set("Content-Type", type);
      x.sendResponseHeaders(status, body.length);
      try (OutputStream out = x.getResponseBody()) { out.write(body); }
    }
  }

  private static final class MemorySlots implements DeviceCredentialStore.Slots {
    final Map<String, String> held = new TreeMap<>();
    @Override public synchronized String read(String slot) { return held.get(slot); }
    @Override public synchronized void write(String slot, String value) { held.put(slot, value); }
    @Override public synchronized void remove(String slot) { held.remove(slot); }
  }

  private static byte[] pattern(int size) {
    byte[] bytes = new byte[size];
    for (int i = 0; i < size; i++) bytes[i] = (byte) (i * 31 + 7);
    return bytes;
  }

  private static byte[] everyByte() {
    byte[] bytes = new byte[256];
    for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
    return bytes;
  }

  private static String sha(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }

  private static String take(String what, Object value) {
    return CredentialJson.quote(what) + ":" + (value instanceof String text ? CredentialJson.quote(text) : String.valueOf(value));
  }

  private static String shown(Outcome outcome) {
    return switch (outcome) {
      case Failed failed -> "failed:" + failed.failure().name();
      case Answered answered -> answered.status() + "/" + answered.etag() + "/" + (answered.body() == null ? "grant" : new String(answered.body(), StandardCharsets.UTF_8));
    };
  }

  private final AtomicLong clock = new AtomicLong(Instant.parse("2026-11-19T12:00:00Z").toEpochMilli());
  private final List<String> notices = new CopyOnWriteArrayList<>();
  private final FakeCloud cloud = new FakeCloud();
  private final DeviceCredentialStore store;
  private final AccountSession session;
  private final File cache;
  private final LargeBodyGrant grants;
  private final CloudRequests requests;

  private CloudRequestJourney() throws IOException {
    store = new DeviceCredentialStore(new MemorySlots(), DeviceCredentialStore.authorityDigest(cloud.origin()), clock::get);
    session = new AccountSession(store, new DeviceKeyClient(URI.create(cloud.origin()), store, ms -> {}));
    store.listen(notice -> notices.add(CredentialPolicy.json(notice)));
    store.onVerifyAccount(() -> notices.add(CredentialPolicy.json(new CredentialPolicy.Notice.VerifyAccount())));
    cache = Files.createTempDirectory("cloud-journey").toFile();
    grants = new LargeBodyGrant(cache);
    requests = new CloudRequests(new CloudRequestPolicy(TABLE), grants);
  }

  private void signIn(String value) {
    int attempt = store.beginSignIn();
    long expires = clock.get() + 30L * 86_400_000L;
    store.tokenAnswered(attempt, new DeviceCredentialStore.Token("cred-" + attempt, value, ACCOUNT, expires));
    store.acknowledged(attempt, "cred-" + attempt, expires);
  }

  private Outcome send(String method, String target, Map<String, String> headers, String body) {
    return requests.send(cloud.origin(), new Custody(store, session), method, target, headers, body == null ? null : body.getBytes(StandardCharsets.UTF_8));
  }

  private String run() throws Exception {
    List<String> seen = new ArrayList<>();

    seen.add(take("signedOutKeyRoute", shown(send("GET", "/api/v1/user", Map.of(), null))));
    seen.add(take("signedOutAsked", cloud.count("GET /api/v1/user")));

    signIn(KEY);
    seen.add(take("userRead", shown(send("GET", "/api/v1/user", Map.of(), null))));
    seen.add(take("keyAttachedNatively", ("Bearer " + KEY).equals(cloud.last("GET /api/v1/user").authorization())));
    seen.add(take("pageAuthorization", shown(send("GET", "/api/v1/user", Map.of("authorization", "Bearer page"), null))));
    seen.add(take("cookie", shown(send("GET", "/api/v1/user", Map.of("Cookie", "a=b"), null))));
    seen.add(take("unlisted", shown(send("GET", "/api/v1/referrals", Map.of(), null))));
    seen.add(take("undeclaredQuery", shown(send("GET", "/api/v1/user?debug=1", Map.of(), null))));
    seen.add(take("otherOrigin", shown(requests.send("http://api.cloud.test", new Custody(store, session), "GET", "/api/v1/user", Map.of(), null))));
    seen.add(take("userAskedAfterRefusals", cloud.count("GET /api/v1/user")));

    seen.add(take("ifMatch", shown(send("DELETE", "/api/v1/eliza/google/calendar/events/e1", Map.of("if-match", "\"7\""), null))));
    seen.add(take("ifMatchSent", cloud.last("DELETE /api/v1/eliza/google/calendar/events/e1").headers().get("If-Match")));
    seen.add(take("ifNoneMatch", shown(send("GET", "/api/v1/eliza/google/calendar/events/e1", Map.of("If-None-Match", "\"8\""), null))));
    seen.add(take("idempotent", shown(send("POST", "/api/v1/maps/geocode", Map.of("Idempotency-Key", "k-1"), "{\"q\":\"x\"}"))));
    Seen geocode = cloud.last("POST /api/v1/maps/geocode");
    seen.add(take("idempotencySent", geocode.headers().get("Idempotency-Key")));
    seen.add(take("bodySent", new String(geocode.body(), StandardCharsets.UTF_8)));
    seen.add(take("idempotencyOnUnkeyedRoute", shown(send("GET", "/api/v1/user", Map.of("Idempotency-Key", "k-2"), null))));

    seen.add(take("freshWithoutSession", shown(send("POST", "/api/v1/subscriptions/cancel", Map.of(), "{}"))));
    seen.add(take("cancelAskedWithoutSession", cloud.count("POST /api/v1/subscriptions/cancel")));
    seen.add(take("sessionGranted", session.grant(ACCOUNT, "access-1", "refresh-1", clock.get() + 900_000)));
    seen.add(take("freshWithSession", shown(send("POST", "/api/v1/subscriptions/cancel", Map.of(), "{}"))));
    seen.add(take("sessionAttached", cloud.last("POST /api/v1/subscriptions/cancel").authorization()));

    Answered invoice = (Answered) send("GET", "/api/v1/billing/invoices/inv1", Map.of(), null);
    seen.add(take("binaryUnchanged", Arrays.equals(invoice.body(), everyByte()) && "application/pdf".equals(invoice.contentType())));

    Answered big = (Answered) send("GET", "/api/v1/eliza/google/gmail/inbox-v1/attachment?size=big", Map.of(), null);
    LargeBodyGrant.Grant grant = big.grant();
    File cached = new File(new File(cache, "cloud-bodies"), grant.sha256());
    seen.add(take("bigGrant", big.body() == null && grant.size() == BIG && grant.sha256().equals(sha(pattern(BIG)))));
    seen.add(take("bigKeptUnderDigest", cached.isFile()));
    ByteArrayOutputStream joined = new ByteArrayOutputStream();
    int chunks = 0;
    for (LargeBodyGrant.Chunk chunk = grants.read(grant.id()); chunk != null; chunk = chunk.done() ? null : grants.read(grant.id())) {
      joined.write(chunk.data());
      chunks++;
    }
    seen.add(take("bigChunks", chunks));
    seen.add(take("bigUnchanged", sha(joined.toByteArray()).equals(grant.sha256())));
    seen.add(take("grantUsedOnce", grants.read(grant.id()) == null));
    seen.add(take("cacheReleased", !cached.exists()));
    seen.add(take("declaredHuge", shown(send("GET", "/api/v1/eliza/google/gmail/inbox-v1/attachment?size=declared-huge", Map.of(), null))));
    seen.add(take("streamedHuge", shown(send("GET", "/api/v1/eliza/google/gmail/inbox-v1/attachment?size=streamed-huge", Map.of(), null))));
    File[] left = new File(cache, "cloud-bodies").listFiles();
    seen.add(take("nothingLeftInCache", left != null && left.length == 0));

    session.drop();
    seen.add(take("expiredReply", shown(send("GET", "/api/v1/models", Map.of(), null))));
    seen.add(take("expiredAsked", cloud.count("GET /api/v1/models")));
    seen.add(take("afterExpired", store.current() == null ? "none" : "held"));

    signIn(KEY + "-revoked");
    seen.add(take("revokedReply", shown(send("GET", "/api/v1/user", Map.of(), null))));
    seen.add(take("afterRevoked", store.current() == null ? "none" : "held"));
    seen.add(CredentialJson.quote("notices") + ":[" + String.join(",", notices) + "]");
    cloud.server.stop(0);
    return "{" + String.join(",", seen) + "}";
  }

  public static void main(String[] args) throws Exception {
    int status = 1;
    try {
      System.out.println(new CloudRequestJourney().run());
      status = 0;
    } finally {
      System.exit(status);
    }
  }
}
