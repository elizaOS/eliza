// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"; spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"; spec/os/signIn/credential.md, "Story: Keep my key fresh without signing in again"
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
    final String challenge, state, renewedFrom;
    int asks;
    String credentialId, secret;
    Grant1(String challenge, String state, String renewedFrom) { this.challenge = challenge; this.state = state; this.renewedFrom = renewedFrom; }
  }

  private static final class FakeCloud {
    final AtomicLong clock;
    final Map<String, Grant1> codes = new ConcurrentHashMap<>();
    final Map<String, String> live = new ConcurrentHashMap<>();
    final List<String> revoked = new CopyOnWriteArrayList<>();
    final List<String> proofs = new CopyOnWriteArrayList<>();
    final List<String> renewedHeaders = new CopyOnWriteArrayList<>();
    final List<String> renewBearers = new CopyOnWriteArrayList<>();
    final Map<String, String> successors = new ConcurrentHashMap<>();
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
          codes.put(code, new Grant1(CredentialJson.text(body, "codeChallenge"), CredentialJson.text(body, "state"), null));
          answer(x, 200, "{\"code\":\"" + code + "\",\"expiresAt\":\"" + iso(now + 300_000) + "\"}");
        }
        case "POST " + DeviceKeyClient.RENEW -> {
          renewBearers.add(bearer(x));
          String predecessor = live.get(bearer(x));
          if (predecessor == null) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          String code = "emac_" + issued.incrementAndGet();
          codes.put(code, new Grant1(CredentialJson.text(body, "codeChallenge"), CredentialJson.text(body, "state"), predecessor));
          answer(x, 200, "{\"code\":\"" + code + "\",\"codeType\":\"mobile_app_auth_code\",\"expiresAt\":\"" + iso(now + 300_000)
            + "\",\"expiresIn\":300,\"renewableUntil\":\"" + iso(now + 180 * DAY_MS) + "\"}");
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
          codes.values().stream().filter(g -> credentialId.equals(g.credentialId) && g.renewedFrom != null).forEach(g -> successors.put(g.renewedFrom, credentialId));
          answer(x, 200, "{\"status\":\"acknowledged\",\"credentialId\":\"" + credentialId + "\",\"expiresAt\":\"" + iso(now + 30 * DAY_MS) + "\"}");
        }
        case "DELETE " + DeviceKeyClient.REVOKE -> {
          revokeAsks.incrementAndGet();
          if (offline) { answer(x, 503, "{\"error\":\"service_unavailable\"}"); return; }
          String named = x.getRequestHeaders().getFirst(DeviceKeyClient.RENEWED_CREDENTIAL);
          renewedHeaders.add(named == null ? "" : named);
          String credentialId = live.remove(bearer(x));
          if (credentialId == null) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          revoked.add(credentialId);
          String successor = successors.get(credentialId);
          if (successor != null && !(successor.equals(named) && live.containsValue(successor))) {
            live.values().removeIf(successor::equals);
            revoked.add(successor);
          }
          x.sendResponseHeaders(204, -1);
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
    String retired = store.owed().get(0).value();
    int beforeRetry = cloud.revokeAsks.get();
    client.settleDuties();
    seen.add(take("onlineRevokeAsks", cloud.revokeAsks.get() - beforeRetry));
    seen.add(take("alreadyRevoked", client.revoke(retired)));
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

  private record FilesystemSlots(Path directory) implements SecureSlot, DeviceCredentialStore.Slots {
    @Override public String read() throws IOException { return read("browser"); }
    @Override public boolean compareExchange(String expected, String value) throws IOException {
      if (!java.util.Objects.equals(read(), expected)) return false;
      if (value == null) remove("browser");
      else write("browser", value);
      return true;
    }

    @Override public String read(String slot) throws IOException {
      Path file = directory.resolve(slot);
      return Files.exists(file) ? Files.readString(file) : null;
    }

    @Override public void write(String slot, String value) throws IOException {
      Path work = Files.createTempFile(directory, "pending-", ".tmp");
      try {
        Files.writeString(work, value);
        Files.move(work, directory.resolve(slot), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } finally {
        Files.deleteIfExists(work);
      }
    }

    @Override public void remove(String slot) throws IOException { Files.deleteIfExists(directory.resolve(slot)); }
  }

  private static final class ObservedReturns implements BrowserReturns.Port {
    BrowserReturns.Handoff handoff;
    int lastEnded;
    int incomplete;
    @Override public void handed(BrowserReturns.Handoff received) { handoff = received; }
    @Override public void ended(String client, int generation, BrowserReturns.Ended why) { lastEnded = generation; }
    @Override public void incomplete(String client) { incomplete++; }
  }

  private static String browserReturn() throws Exception {
    Path directory = Files.createTempDirectory("device-browser-return-");
    try {
      var slots = new FilesystemSlots(directory);
      var clock = Instant.parse("2026-11-19T12:00:00Z");
      final String authority = DeviceCredentialStore.authorityDigest("https://staging.example.test");
      final var checks = new BrowserReturnPolicy.StartChecks(true, true, true, true);
      final var signIn = BrowserReturns.Purpose.SIGN_IN;
      final var reauthenticate = BrowserReturns.Purpose.REAUTHENTICATE;
      var first = new DeviceCredentialStore(slots, authority, clock::toEpochMilli);
      var before = new BrowserReturns(slots, first, new ObservedReturns());
      String firstState = SignInPolicy.newState();
      var opened = before.start("staging", firstState, SignInPolicy.newVerifier(), signIn, checks);
      var restored = new DeviceCredentialStore(slots, authority, clock::toEpochMilli);
      var observed = new ObservedReturns();
      var returns = new BrowserReturns(slots, restored, observed);
      var code = new BrowserReturnPolicy.Callback.Code("staging", firstState, "fixture-code");
      boolean adopted = returns.returned(code) == BrowserReturns.Return.HANDED &&
        observed.handoff.owner() == BrowserReturnPolicy.Owner.ADOPTED && observed.handoff.generation() == opened.generation() &&
        restored.state().attempt().equals(new CredentialPolicy.Attempt.Exchanging(opened.generation())) && returns.takeExchange(observed.handoff);
      boolean oneUse = !returns.takeExchange(observed.handoff) && returns.returned(code) == BrowserReturns.Return.IGNORED && slots.read() == null;
      restored.signInEnded(opened.generation());

      String oldState = SignInPolicy.newState(), newerState = SignInPolicy.newState();
      var previous = returns.start("staging", oldState, SignInPolicy.newVerifier(), signIn, checks);
      var newer = returns.start("staging", newerState, SignInPolicy.newVerifier(), signIn, checks);
      returns.cancel(previous);
      boolean isolated = observed.lastEnded == previous.generation() &&
        returns.returned(new BrowserReturnPolicy.Callback.Code("staging", oldState, "old")) == BrowserReturns.Return.IGNORED &&
        returns.returned(new BrowserReturnPolicy.Callback.Code("staging", newerState, "current")) == BrowserReturns.Return.HANDED &&
        observed.handoff.owner() == BrowserReturnPolicy.Owner.LIVE && observed.handoff.generation() == newer.generation();
      int concurrent = restored.beginSignIn();
      boolean drift = !returns.mayExchange(observed.handoff) && !returns.takeExchange(observed.handoff);
      returns.exchangeEnded(newer.generation());
      drift &= restored.state().attempt().equals(new CredentialPolicy.Attempt.Exchanging(concurrent));
      restored.signInEnded(concurrent);

      int installing = restored.beginSignIn();
      long keyExpiry = clock.plusSeconds(3600).toEpochMilli();
      if (restored.tokenAnswered(installing, new DeviceCredentialStore.Token("active", "eliza_mobile_fixture", ACCOUNT, keyExpiry)) != DeviceCredentialStore.Kept.KEPT ||
          restored.acknowledged(installing, "active", keyExpiry) != DeviceCredentialStore.Outcome.ACCEPTED) {
        throw new IllegalStateException("The device credential fixture did not commit");
      }
      String liveState = SignInPolicy.newState();
      var liveReauth = returns.start("staging", liveState, SignInPolicy.newVerifier(), reauthenticate, checks);
      boolean keptAccount = returns.returned(new BrowserReturnPolicy.Callback.Code("staging", liveState, "reauth")) == BrowserReturns.Return.HANDED &&
        observed.handoff.purpose() == reauthenticate && returns.mayExchange(observed.handoff) && returns.takeExchange(observed.handoff);
      restored.signInEnded(liveReauth.generation());
      keptAccount &= CredentialPolicy.activeVersion(restored.state()) == 1 && CredentialPolicy.accountOf(restored.state()).equals(ACCOUNT);

      String reauthState = SignInPolicy.newState();
      var asked = returns.start("staging", reauthState, SignInPolicy.newVerifier(), reauthenticate, checks);
      var restarted = new DeviceCredentialStore(slots, authority, clock::toEpochMilli);
      var cold = new ObservedReturns();
      var newProcess = new BrowserReturns(slots, restarted, cold);
      boolean reauthClosed = newProcess.returned(new BrowserReturnPolicy.Callback.Code("staging", reauthState, "reauthentication")) == BrowserReturns.Return.NOT_ADMITTED &&
        cold.handoff == null && cold.incomplete == 1 && restarted.generation() == asked.generation() &&
        CredentialPolicy.activeVersion(restarted.state()) == 1 && slots.read() == null;
      return "{\"adopted\":" + adopted + ",\"oneUse\":" + oneUse + ",\"isolated\":" + isolated +
        ",\"drift\":" + drift + ",\"reauthClosed\":" + reauthClosed + ",\"keptAccount\":" + keptAccount + "}";
    } finally {
      try (var files = Files.list(directory)) {
        for (Path file : files.toList()) Files.delete(file);
      }
      Files.delete(directory);
    }
  }

  private String renewal() throws Exception {
    List<String> seen = new ArrayList<>();
    seen.add(take("signedIn", signIn()));
    String first = store.current().credentialId();
    seen.add(take("notYetDue", client.renewKey(BINDING).name()));
    seen.add(take("renewAsksBeforeDue", cloud.renewBearers.size()));
    clock.addAndGet(21 * DAY_MS);
    String predecessorKey = store.current().value();
    seen.add(take("renewed", client.renewKey(BINDING).name()));
    seen.add(take("askedWithTheActiveKey", cloud.renewBearers.equals(List.of(predecessorKey))));
    CredentialReader.Credential successor = store.current();
    seen.add(take("heldAfterRenewal", successor.version() + "/" + successor.credentialId() + "/" + successor.account().userId()));
    seen.add(take("owedNamesSuccessor", store.owed().size() == 1 && store.owed().get(0).successor().equals(successor.credentialId())));
    client.settleDuties();
    seen.add(take("revokedAfterRenewal", String.join(",", cloud.revoked)));
    seen.add(take("successorLive", client.user(successor.value()) instanceof DeviceKeyClient.Answer.Answered<Account>));
    seen.add(take("firstReplaced", !first.equals(successor.credentialId())));
    store.signOut();
    client.settleDuties();
    seen.add(take("renewedHeaders", String.join(",", cloud.renewedHeaders.stream().map(h -> h.isEmpty() ? "none" : h).toList())));
    seen.add(take("revokedAfterSignOut", String.join(",", cloud.revoked)));
    seen.add(CredentialJson.quote("notices") + ":[" + String.join(",", notices) + "]");
    cloud.server.stop(0);
    return "{" + String.join(",", seen) + "}";
  }

  public static void main(String[] args) throws Exception {
    if (args.length == 1 && args[0].equals("browser")) System.out.println(browserReturn());
    else if (args.length == 1 && args[0].equals("renewal")) System.out.println(new DeviceKeyJourney().renewal());
    else System.out.println(new DeviceKeyJourney().run());
    System.exit(0);
  }
}
