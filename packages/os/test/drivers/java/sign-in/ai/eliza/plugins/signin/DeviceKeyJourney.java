// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.Notice;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Binding;
import ai.eliza.plugins.signin.DeviceKeyClient.Grant;
import ai.eliza.plugins.signin.DeviceKeyClient.Proof;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

public final class DeviceKeyJourney {
  private static final String SESSION = "eliza_session_journey";
  private static final Account ACCOUNT = new Account("user-1", "org-1");
  private static final Binding BINDING = new Binding("client-1", "staging", "https://app.test/auth/callback");
  private static final long DAY_MS = 86_400_000L;

  private static final class Grant1 {
    final String challenge, state;
    int asks;
    String credentialId, secret;
    Grant1(String challenge, String state) { this.challenge = challenge; this.state = state; }
  }

  private static final class FakeCloud {
    final AtomicLong clock;
    final Map<String, Grant1> codes = new ConcurrentHashMap<>();
    final Map<String, String> live = new ConcurrentHashMap<>();
    final List<String> revoked = new CopyOnWriteArrayList<>();
    final List<String> proofs = new CopyOnWriteArrayList<>();
    final AtomicInteger issued = new AtomicInteger(), tokenAsks = new AtomicInteger(), revokeAsks = new AtomicInteger(), refreshes = new AtomicInteger();
    volatile boolean offline;
    final HttpServer server;

    FakeCloud(AtomicLong clock) throws IOException {
      this.clock = clock;
      server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
      server.setExecutor(Executors.newCachedThreadPool());
      server.createContext("/", this::handle);
      server.start();
    }

    URI origin() { return URI.create("http://127.0.0.1:" + server.getAddress().getPort()); }

    private String iso(long at) { return Instant.ofEpochMilli(at).toString(); }

    private String bearer(HttpExchange x) {
      String value = x.getRequestHeaders().getFirst("Authorization");
      return value != null && value.startsWith("Bearer ") ? value.substring(7) : "";
    }

    private void handle(HttpExchange x) throws IOException {
      String route = x.getRequestMethod() + " " + x.getRequestURI().getPath();
      Map<String, Object> body = "POST".equals(x.getRequestMethod())
        ? CredentialJson.object(CredentialJson.parse(new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)), "body") : Map.of();
      long now = clock.get();
      switch (route) {
        case "POST " + DeviceKeyClient.CONNECT -> {
          if (!SESSION.equals(bearer(x))) { answer(x, 401, "{\"error\":\"authentication_required\"}"); return; }
          String code = "emac_" + issued.incrementAndGet();
          codes.put(code, new Grant1(CredentialJson.text(body, "codeChallenge"), CredentialJson.text(body, "state")));
          answer(x, 200, "{\"code\":\"" + code + "\",\"expiresAt\":\"" + iso(now + 300_000) + "\"}");
        }
        case "POST " + DeviceKeyClient.TOKEN -> {
          tokenAsks.incrementAndGet();
          Grant1 grant = codes.get(CredentialJson.text(body, "code"));
          String verifier = CredentialJson.text(body, "codeVerifier");
          proofs.add(CredentialJson.text(body, "code") + "/" + verifier);
          if (grant == null || !grant.challenge.equals(SignInPolicy.s256(verifier)) || !grant.state.equals(CredentialJson.text(body, "state"))) {
            answer(x, 401, "{\"error\":\"credential_proof_invalid\"}");
            return;
          }
          if (grant.credentialId == null) {
            grant.credentialId = "cred-" + issued.incrementAndGet();
            grant.secret = "eliza_mobile_" + grant.credentialId;
          }
          if (grant.asks++ == 0) { x.close(); return; }
          answer(x, 200, "{\"credentialId\":\"" + grant.credentialId + "\",\"secret\":\"" + grant.secret + "\",\"tokenType\":\"Bearer\",\"expiresAt\":\""
            + iso(now + 30 * DAY_MS) + "\",\"user\":{\"id\":\"" + ACCOUNT.userId() + "\"},\"organizationId\":\"" + ACCOUNT.organizationId() + "\"}");
        }
        case "POST " + DeviceKeyClient.ACK -> {
          String credentialId = CredentialJson.text(body, "credentialId");
          boolean known = codes.values().stream().anyMatch(g -> credentialId.equals(g.credentialId) && CredentialJson.text(body, "secret").equals(g.secret));
          if (!known) { answer(x, 401, "{\"error\":\"credential_proof_invalid\"}"); return; }
          live.put(CredentialJson.text(body, "secret"), credentialId);
          answer(x, 200, "{\"status\":\"acknowledged\",\"credentialId\":\"" + credentialId + "\",\"expiresAt\":\"" + iso(now + 30 * DAY_MS) + "\"}");
        }
        case "DELETE " + DeviceKeyClient.REVOKE -> {
          revokeAsks.incrementAndGet();
          if (offline) { answer(x, 503, "{\"error\":\"service_unavailable\"}"); return; }
          String credentialId = live.remove(bearer(x));
          if (credentialId == null) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          revoked.add(credentialId);
          answer(x, 200, "{\"status\":\"revoked\",\"credentialId\":\"" + credentialId + "\"}");
        }
        case "GET " + DeviceKeyClient.USER -> {
          if (!live.containsKey(bearer(x))) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_revoked\"}"); return; }
          answer(x, 200, "{\"success\":true,\"data\":{\"id\":\"" + ACCOUNT.userId() + "\",\"organization_id\":\"" + ACCOUNT.organizationId() + "\"}}");
        }
        case "POST " + AccountSession.REFRESH -> {
          int n = refreshes.incrementAndGet();
          try { Thread.sleep(300); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
          if (!("refresh-" + n).equals(CredentialJson.text(body, "refreshToken"))) { answer(x, 401, "{\"error\":\"authentication_required\"}"); return; }
          answer(x, 200, "{\"accessToken\":\"access-" + (n + 1) + "\",\"refreshToken\":\"refresh-" + (n + 1) + "\",\"accessExpiresAt\":" + (now + 900_000) + "}");
        }
        default -> answer(x, 404, "{\"error\":\"not_found\"}");
      }
    }

    private static void answer(HttpExchange x, int status, String body) throws IOException {
      byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
      x.getResponseHeaders().set("Content-Type", "application/json");
      x.sendResponseHeaders(status, bytes.length);
      try (OutputStream out = x.getResponseBody()) { out.write(bytes); }
    }
  }

  private static final class MemorySlots implements DeviceCredentialStore.Slots {
    final Map<String, String> held = new TreeMap<>();
    @Override public synchronized String read(String slot) { return held.get(slot); }
    @Override public synchronized void write(String slot, String value) { held.put(slot, value); }
    @Override public synchronized void remove(String slot) { held.remove(slot); }
  }

  private final AtomicLong clock = new AtomicLong(Instant.parse("2026-11-19T12:00:00Z").toEpochMilli());
  private final MemorySlots slots = new MemorySlots();
  private final List<String> notices = new CopyOnWriteArrayList<>();
  private final FakeCloud cloud;
  private DeviceCredentialStore store;
  private DeviceKeyClient client;

  private DeviceKeyJourney() throws IOException {
    cloud = new FakeCloud(clock);
    start();
  }

  private void start() {
    store = new DeviceCredentialStore(slots, DeviceCredentialStore.authorityDigest(cloud.origin().toString()), clock::get);
    client = new DeviceKeyClient(cloud.origin(), store, ms -> {});
    store.listen(notice -> notices.add(CredentialPolicy.json(notice)));
    store.onVerifyAccount(() -> { notices.add(CredentialPolicy.json(new Notice.VerifyAccount())); client.verifyAccount(); });
  }

  private String signIn() {
    int attempt = store.beginSignIn();
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    Answer<Grant> grant = client.connect(SESSION, BINDING, state, SignInPolicy.s256(verifier), "Journey phone");
    if (!(grant instanceof Answer.Answered<Grant> granted)) throw new IllegalStateException("connect " + grant);
    return client.exchange(attempt, BINDING, new Proof(granted.value().code(), state, verifier)).name();
  }

  private String held() {
    CredentialReader.Credential current = store.current();
    return current == null ? "none" : current.version() + "/" + current.credentialId() + "/" + current.account().userId();
  }

  private static String take(String what, Object value) {
    return CredentialJson.quote(what) + ":" + (value instanceof String text ? CredentialJson.quote(text) : String.valueOf(value));
  }

  private String run() throws Exception {
    List<String> seen = new ArrayList<>();
    String prefix = "sign-in:" + DeviceCredentialStore.authorityDigest(cloud.origin().toString()) + ":";

    seen.add(take("firstSignIn", signIn()));
    seen.add(take("firstHeld", held()));
    seen.add(take("lostReplyAskedAgainWithSameProof", cloud.proofs.size() == 2 && cloud.proofs.get(0).equals(cloud.proofs.get(1))));
    seen.add(take("keyHiddenFromText", !store.current().toString().contains(store.current().value())));
    seen.add(take("unknownAckRefusal", client.ack("cred-unknown", "eliza_unknown") instanceof DeviceKeyClient.Answer.Refused<?> r ? r.status() + "/" + r.error() : "answered"));

    seen.add(take("secondSignIn", signIn()));
    seen.add(take("secondHeld", held()));
    seen.add(take("owedAfterReplace", store.owed().size()));
    client.settleDuties();
    seen.add(take("revokedAfterReplace", String.join(",", cloud.revoked)));

    cloud.offline = true;
    store.signOut();
    String record = slots.read(prefix + "credential");
    seen.add(take("dutyStoredWithSignOut", record.contains("\"duties\":[{\"version\":2,")));
    int before = cloud.revokeAsks.get();
    client.settleDuties();
    seen.add(take("offlineRevokeAsks", cloud.revokeAsks.get() - before));
    seen.add(take("dutiesKeptOffline", store.state().duties().size()));

    cloud.offline = false;
    start();
    seen.add(take("triesAtStart", store.owed().get(0).tries()));
    client.settleDuties();
    seen.add(take("revokedAfterStart", String.join(",", cloud.revoked)));
    seen.add(take("dutiesAfterStart", store.state().duties().size()));

    seen.add(take("thirdSignIn", signIn()));
    cloud.live.clear();
    store.report401(store.current().version(), "credential_revoked");
    seen.add(take("afterRevokedElsewhere", held()));

    seen.add(take("fourthSignIn", signIn()));
    store.report401(store.current().version(), "credential_expired");
    seen.add(take("afterExpired", held() + "/" + store.account().userId()));
    seen.add(take("dutiesAfterCloudEnded", store.state().duties().size()));

    seen.add(take("fifthSignIn", signIn()));
    AccountSession session = new AccountSession(store, client);
    seen.add(take("otherAccountRefused", !session.grant(new Account("user-2", "org-2"), "access-1", "refresh-1", clock.get() + 900_000)));
    seen.add(take("sessionGranted", session.grant(ACCOUNT, "access-1", "refresh-1", clock.get() + 900_000)));
    seen.add(take("usableToken", session.accessToken()));
    clock.addAndGet(1_000_000);
    ExecutorService readers = Executors.newFixedThreadPool(4);
    List<Future<String>> reads = new ArrayList<>();
    for (int i = 0; i < 4; i++) reads.add(readers.submit(session::accessToken));
    List<String> tokens = new ArrayList<>();
    for (Future<String> read : reads) tokens.add(read.get());
    readers.shutdown();
    seen.add(take("refreshesForFourReaders", cloud.refreshes.get()));
    seen.add(take("tokensAfterRefresh", String.join(",", tokens)));
    clock.addAndGet(3_000_000);
    seen.add(take("afterTheHour", String.valueOf(session.accessToken())));

    Map<String, Integer> kinds = new HashMap<>();
    for (String slot : slots.held.keySet()) kinds.merge(slot.startsWith(prefix) ? "prefixed" : "other", 1, Integer::sum);
    seen.add(take("unprefixedSlots", kinds.getOrDefault("other", 0)));
    seen.add(CredentialJson.quote("notices") + ":[" + String.join(",", notices) + "]");
    cloud.server.stop(0);
    return "{" + String.join(",", seen) + "}";
  }

  public static void main(String[] args) throws Exception {
    System.out.println(new DeviceKeyJourney().run());
    System.exit(0);
  }
}
