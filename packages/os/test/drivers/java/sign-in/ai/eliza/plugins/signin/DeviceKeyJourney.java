// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"; spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
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
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
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
import java.util.concurrent.atomic.AtomicReference;

public final class DeviceKeyJourney {
  private static final String SESSION = "eliza_session_journey";
  private static final Account ACCOUNT = new Account("user-1", "org-1");
  private static final Binding BINDING = new Binding("client-1", "staging", "https://app.test/auth/callback");
  private static final long DAY_MS = 86_400_000L;

  private static final class Grant1 {
    final String challenge, state;
    int asks;
    String credentialId, secret;
    Family lease;
    Grant1(String challenge, String state) { this.challenge = challenge; this.state = state; }
  }

  private static final class Family {
    String grant, refresh, access, offeredRefresh, offeredAccess;
    long accessExpiresAt;
    boolean ended;
    final List<String> spent = new ArrayList<>();
    boolean holds(String bearer) { return bearer.equals(refresh) || bearer.equals(offeredRefresh) || spent.contains(bearer); }
  }

  private record Renewal(String secret, Family lease, String from) {}

  private static final class FakeCloud {
    final AtomicLong clock;
    final Map<String, Grant1> codes = new ConcurrentHashMap<>();
    final Map<String, String> live = new ConcurrentHashMap<>();
    final List<String> revoked = new CopyOnWriteArrayList<>();
    final List<String> revokeSuccessors = new CopyOnWriteArrayList<>();
    final List<String> proofs = new CopyOnWriteArrayList<>();
    final AtomicInteger issued = new AtomicInteger(), tokenAsks = new AtomicInteger(), revokeAsks = new AtomicInteger(), refreshes = new AtomicInteger();
    final AtomicInteger ackAsks = new AtomicInteger();
    final AtomicInteger rotations = new AtomicInteger(), reused = new AtomicInteger(), secrets = new AtomicInteger();
    final AtomicReference<Runnable> beforeMailReply = new AtomicReference<>();
    final AtomicReference<Runnable> beforeLeaseReply = new AtomicReference<>();
    final List<Family> families = new CopyOnWriteArrayList<>();
    final Map<String, Renewal> renewals = new ConcurrentHashMap<>();
    final List<String> mailBearers = new CopyOnWriteArrayList<>(), modelBearers = new CopyOnWriteArrayList<>(), brokerBearers = new CopyOnWriteArrayList<>();
    volatile boolean offline, leases, dropNextRotation;
    volatile Account tokenOwner = ACCOUNT;
    volatile int dropAcks;
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

    private String minted(String prefix, int length) {
      String serial = Integer.toString(secrets.incrementAndGet());
      return prefix + "s".repeat(length - serial.length()) + serial;
    }

    private Family family(String bearer) {
      for (Family f : families) if (f.holds(bearer)) return f;
      return null;
    }

    private void endGrant(String credentialId) {
      live.values().removeIf(credentialId::equals);
      for (Family f : families) if (credentialId.equals(f.grant)) f.ended = true;
    }

    private boolean presented(HttpExchange x, Family f, String bearer) throws IOException {
      if (f == null) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return false; }
      if (!f.ended && f.spent.contains(bearer)) {
        reused.incrementAndGet();
        endGrant(f.grant);
      }
      if (f.ended) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_revoked\"}"); return false; }
      if (bearer.equals(f.offeredRefresh)) commit(f);
      return true;
    }

    private void commit(Family f) {
      f.spent.add(f.refresh);
      f.refresh = f.offeredRefresh;
      f.access = f.offeredAccess;
      f.offeredRefresh = f.offeredAccess = null;
    }

    private String offer(Family f, long now) {
      f.offeredRefresh = minted("eliza_lease_refresh_", 54);
      f.offeredAccess = minted("eliza_lease_", 43);
      f.accessExpiresAt = now + 900_000;
      return "{\"access\":\"" + f.offeredAccess + "\",\"accessExpiresIn\":900,\"refresh\":\"" + f.offeredRefresh + "\",\"refreshExpiresIn\":7776000}";
    }

    private boolean leaseAccess(String bearer, long now) {
      for (Family f : families) {
        if (f.ended || now >= f.accessExpiresAt) continue;
        if (bearer.equals(f.offeredAccess)) commit(f);
        if (bearer.equals(f.access)) return true;
      }
      return false;
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
            if (leases) {
              grant.lease = new Family();
              grant.lease.grant = grant.credentialId;
              grant.lease.refresh = minted("eliza_lease_refresh_", 54);
            }
          }
          if (grant.asks++ == 0) { x.close(); return; }
          String lease = grant.lease == null ? "" : ",\"lease\":{\"refresh\":\"" + grant.lease.refresh + "\",\"refreshExpiresIn\":7776000}";
          answer(x, 200, "{\"credentialId\":\"" + grant.credentialId + "\",\"secret\":\"" + grant.secret + "\",\"tokenType\":\"Bearer\",\"expiresAt\":\""
            + iso(now + 30 * DAY_MS) + "\",\"user\":{\"id\":\"" + tokenOwner.userId() + "\"},\"organizationId\":\"" + tokenOwner.organizationId() + "\"" + lease + "}");
        }
        case "POST " + DeviceKeyClient.ACK -> {
          ackAsks.incrementAndGet();
          String credentialId = CredentialJson.text(body, "credentialId"), secret = CredentialJson.text(body, "secret");
          Grant1 signedIn = codes.values().stream().filter(g -> credentialId.equals(g.credentialId) && secret.equals(g.secret)).findFirst().orElse(null);
          Renewal renewed = renewals.get(credentialId);
          if (signedIn == null && (renewed == null || !renewed.secret().equals(secret))) { answer(x, 401, "{\"error\":\"credential_proof_invalid\"}"); return; }
          if (signedIn != null && signedIn.lease != null && !families.contains(signedIn.lease)) families.add(signedIn.lease);
          if (renewed != null) {
            live.values().removeIf(renewed.from()::equals);
            renewed.lease().grant = credentialId;
          }
          live.put(secret, credentialId);
          if (dropAcks > 0) { dropAcks--; x.close(); return; }
          answer(x, 200, "{\"status\":\"acknowledged\",\"credentialId\":\"" + credentialId + "\",\"expiresAt\":\"" + iso(now + 30 * DAY_MS) + "\"}");
        }
        case "DELETE " + DeviceKeyClient.REVOKE -> {
          revokeAsks.incrementAndGet();
          String successor = x.getRequestHeaders().getFirst("X-Renewed-Credential-Id");
          revokeSuccessors.add(successor == null ? "" : successor);
          if (offline) { answer(x, 503, "{\"error\":\"service_unavailable\"}"); return; }
          String credentialId = live.remove(bearer(x));
          if (credentialId == null) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          revoked.add(credentialId);
          endGrant(credentialId);
          x.sendResponseHeaders(204, -1);
        }
        case "POST " + DeviceKeyClient.LEASE -> {
          Family f = family(bearer(x));
          if (!presented(x, f, bearer(x))) return;
          rotations.incrementAndGet();
          String pair = offer(f, now);
          if (dropNextRotation) { dropNextRotation = false; x.close(); return; }
          Runnable before = beforeLeaseReply.getAndSet(null);
          if (before != null) before.run();
          answer(x, 200, pair);
        }
        case "DELETE " + DeviceKeyClient.LEASE -> {
          if (offline) { answer(x, 503, "{\"error\":\"service_unavailable\"}"); return; }
          Family f = family(bearer(x));
          if (!presented(x, f, bearer(x))) return;
          f.ended = true;
          x.sendResponseHeaders(204, -1);
        }
        case "POST " + DeviceKeyClient.RENEW -> {
          Family f = family(bearer(x));
          if (!presented(x, f, bearer(x))) return;
          String credentialId = "cred-" + issued.incrementAndGet();
          renewals.put(credentialId, new Renewal("eliza_mobile_" + credentialId, f, f.grant));
          answer(x, 200, "{\"credentialId\":\"" + credentialId + "\",\"secret\":\"eliza_mobile_" + credentialId + "\",\"expiresIn\":" + 30 * DAY_MS / 1000 + "}");
        }
        case "GET /api/v1/eliza/google/calendar/feed" -> {
          String bearer = bearer(x);
          if (live.containsKey(bearer)) { mailBearers.add("key"); answer(x, 403, "{\"error\":\"forbidden\",\"reason\":\"device_key_not_allowed\"}"); return; }
          if (!leaseAccess(bearer, now)) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          mailBearers.add("lease");
          Runnable before = beforeMailReply.getAndSet(null);
          if (before != null) before.run();
          answer(x, 200, "{\"events\":[]}");
        }
        case "GET /api/v1/eliza/google/accounts" -> {
          String bearer = bearer(x);
          if (live.containsKey(bearer)) { brokerBearers.add("key"); answer(x, 403, "{\"error\":\"forbidden\",\"reason\":\"device_key_not_allowed\"}"); return; }
          if (!leaseAccess(bearer, now)) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          brokerBearers.add("lease");
          answer(x, 200, "{\"accounts\":[]}");
        }
        case "GET /api/v1/models" -> {
          if (!live.containsKey(bearer(x))) { answer(x, 401, "{\"error\":\"authentication_required\",\"reason\":\"credential_unknown\"}"); return; }
          modelBearers.add("key");
          answer(x, 200, "{\"data\":[]}");
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
  private DeviceLease lease;

  private DeviceKeyJourney() throws IOException {
    cloud = new FakeCloud(clock);
    start();
  }

  private void start() {
    store = new DeviceCredentialStore(slots, DeviceCredentialStore.authorityDigest(cloud.origin().toString()), clock::get);
    client = new DeviceKeyClient(cloud.origin(), store, ms -> {}, clock::get);
    store.listen(notice -> notices.add(CredentialPolicy.json(notice)));
    store.onVerifyAccount(() -> { notices.add(CredentialPolicy.json(new Notice.VerifyAccount())); client.verifyAccount(); });
    store.onRenewKey(() -> client.renew());
    lease = new DeviceLease(store, client, () -> client.renewIfDue());
  }

  private long leaseSlots(String prefix) {
    return slots.held.keySet().stream().filter(slot -> slot.startsWith(prefix) && (slot.contains(":key:") || slot.contains(":lease:"))).count();
  }

  private String leaseJourney(List<String> seen, String prefix) {
    int before = notices.size();
    cloud.leases = true;
    seen.add(take("leasedSignIn", signIn()));
    client.settleDuties();
    cloud.dropNextRotation = true;
    seen.add(take("lostRotation", String.valueOf(lease.accessToken())));
    DeviceLease.Held rotated = lease.accessToken();
    clock.addAndGet(16 * 60_000L);
    DeviceLease.Held again = lease.accessToken();
    seen.add(take("rotatedAfterLostReply", rotated != null && again != null && !rotated.token().equals(again.token())));
    seen.add(take("rotationsAsked", cloud.rotations.get()));
    String leased = store.current().credentialId();
    clock.addAndGet(15 * DAY_MS);
    DeviceLease.Held renewing = lease.accessToken();
    seen.add(take("renewedAtHalfLife", !store.current().credentialId().equals(leased) ? held() : "not renewed"));
    seen.add(take("oldLeaseReadEnded", renewing == null));
    seen.add(take("owedAfterRenewal", store.owed().size() == 1 && store.owed().get(0).lease() == null));
    client.settleDuties();
    seen.add(take("replacedKeyEnded", !cloud.live.containsValue(leased) && store.owed().isEmpty()));
    clock.addAndGet(16 * 60_000L);
    seen.add(take("leaseKeptByRenewal", lease.accessToken() != null));
    int beforeLostAck = store.current().version();
    cloud.dropAcks = DeviceKeyClient.ASKS;
    clock.addAndGet(15 * DAY_MS);
    lease.accessToken();
    boolean stranded = store.pendingRenewal() != null && store.current().version() == beforeLostAck;
    store.report401(beforeLostAck, "credential_revoked");
    seen.add(take("lostRenewalAckAskedAgain", stranded && store.pendingRenewal() == null && store.current().version() == beforeLostAck + 1 ? held() : "stranded"));
    client.settleDuties();
    clock.addAndGet(16 * 60_000L);
    int beforeRace = store.current().version();
    boolean racing = store.readLease().stage() == DeviceCredentialStore.SessionRead.START_REFRESH && client.renew() == DeviceKeyClient.Exchange.SIGNED_IN;
    DeviceCredentialStore.Kept late = store.leaseRotated(beforeRace, "eliza_lease_refresh_" + "s".repeat(54), clock.get() + 900_000, clock.get() + 90 * DAY_MS);
    seen.add(take("rotationAfterRenewalAck", racing + "/" + late + "/" + (lease.accessToken() != null)));
    client.settleDuties();
    String renewed = store.current().credentialId();
    cloud.families.get(cloud.families.size() - 1).ended = true;
    clock.addAndGet(16 * 60_000L);
    seen.add(take("accessAfterRevokedLease", String.valueOf(lease.accessToken())));
    seen.add(take("afterRevokedLease", held()));
    seen.add(take("owedAfterRevokedLease", store.owed().size() == 1 && store.owed().get(0).lease() == null));
    client.settleDuties();
    seen.add(take("keyRevokedAfterLease", cloud.revoked.contains(renewed)));
    seen.add(take("slotsAfterLeaseSignOut", leaseSlots(prefix)));
    seen.add(take("leaseReuses", cloud.reused.get()));
    return CredentialJson.quote("leaseNotices") + ":[" + String.join(",", notices.subList(before, notices.size())) + "]";
  }

  private static final String MAIL_TABLE = "[{\"prefixes\":[\"/api/v1\"],\"routes\":["
    + "{\"method\":\"GET\",\"path\":\"/api/v1/eliza/google/calendar/feed\"},{\"method\":\"GET\",\"path\":\"/api/v1/models\"}]}]";

  private static String outcome(CloudRequests.Outcome outcome) {
    return switch (outcome) {
      case CloudRequests.Answered answered -> String.valueOf(answered.status());
      case CloudRequests.Failed failed -> failed.failure().name();
    };
  }

  private String cloudJourney() throws Exception {
    Path cache = Files.createTempDirectory("device-cloud-requests-");
    try {
      CloudRequests requests = new CloudRequests(new CloudRequestPolicy(MAIL_TABLE), new LargeBodyGrant(cache.toFile()));
      CloudRequests.Custody custody = new CloudRequests.Custody(store, new AccountSession(store, client), lease);
      String origin = cloud.origin().toString();
      String feed = "/api/v1/eliza/google/calendar/feed", models = "/api/v1/models";
      List<String> seen = new ArrayList<>();
      seen.add(take("mailSignedOut", outcome(requests.send(origin, custody, "GET", feed, Map.of(), null))));
      seen.add(take("keyOnlySignIn", signIn()));
      String oldKey = store.current().credentialId();
      String recordSlot = DeviceCredentialStore.NAMESPACE + ":" + DeviceCredentialStore.authorityDigest(origin) + ":credential";
      String snapshot = slots.read(recordSlot);
      String oldSnapshot = snapshot.replace(",\"lease\":{\"tag\":\"NoLease\"}", "");
      if (oldSnapshot.equals(snapshot)) throw new IllegalStateException("The key-only record did not contain an empty lease");
      slots.write(recordSlot, oldSnapshot);
      start();
      custody = new CloudRequests.Custody(store, new AccountSession(store, client), lease);
      seen.add(take("mailWithoutLease", outcome(requests.send("upgrade", origin, custody, "GET", feed, Map.of(), null))));
      CloudRequests.Custody keyOnly = custody;
      try (GoogleBrokerHost broker = GoogleBrokerHost.overDevice(origin, () -> keyOnly, cache.toFile(), failure -> { throw failure; })) {
        seen.add(take("brokerReadWithoutLease", GoogleBrokerJourney.read(broker.open(new AgentCredentials.Account(ACCOUNT.userId(), ACCOUNT.organizationId())),
          "/api/v1/eliza/google/accounts?side=owner")));
      }
      seen.add(take("settledRequestCancelled", requests.cancel("upgrade")));
      var expected = CredentialPolicy.mailLeaseUpgrade(store.state());
      int cancelled = store.beginMailLeaseUpgrade(expected);
      store.signInEnded(cancelled);
      seen.add(take("oldKeyAfterCancel", oldKey.equals(store.current().credentialId())));
      seen.add(take("mailAfterCancel", outcome(requests.send(origin, custody, "GET", feed, Map.of(), null))));
      seen.add(take("inferenceBeforeUpgrade", outcome(requests.send(origin, custody, "GET", models, Map.of(), null))));
      int priorAcks = cloud.ackAsks.get();
      seen.add(take("upgradeWithoutLease", client.exchange(store.beginMailLeaseUpgrade(expected), BINDING, proof()).name()));
      cloud.leases = true;
      cloud.tokenOwner = new Account(ACCOUNT.userId(), "another-organization");
      seen.add(take("upgradeToOtherOrganization", client.exchange(store.beginMailLeaseUpgrade(expected), BINDING, proof()).name()));
      cloud.tokenOwner = ACCOUNT;
      seen.add(take("refusalsKeptOldKey", oldKey.equals(store.current().credentialId()) && store.owed().size() == 2));
      int interrupted = store.beginMailLeaseUpgrade(expected);
      Proof unfinished = proof();
      client.token(BINDING, unfinished);
      Answer<DeviceCredentialStore.Token> second = client.token(BINDING, unfinished);
      if (!(second instanceof Answer.Answered<DeviceCredentialStore.Token> minted)
          || store.tokenAnswered(interrupted, minted.value()) != DeviceCredentialStore.Kept.KEPT) {
        throw new IllegalStateException("The interrupted upgrade did not stage a pending grant");
      }
      start();
      custody = new CloudRequests.Custody(store, new AccountSession(store, client), lease);
      seen.add(take("restartRetiredPendingUpgrade", store.pending() == null && store.owed().size() == 3 && oldKey.equals(store.current().credentialId())));
      seen.add(take("failedUpgradeAcknowledgements", cloud.ackAsks.get() - priorAcks));
      seen.add(take("leasedSignIn", client.exchange(store.beginMailLeaseUpgrade(expected), BINDING, proof()).name()));
      seen.add(take("upgradeStayedWithOwner", ACCOUNT.equals(store.current().account()) && store.beginMailLeaseUpgrade(expected) == 0));
      cloud.dropNextRotation = true;
      seen.add(take("mailAfterLostRotation", outcome(requests.send(origin, custody, "GET", feed, Map.of(), null))));
      CloudRequests managed = CloudRequests.forMailReads(cache.toFile());
      var mailAuthority = requireMailAuthority(custody);
      var stale = new CloudRequests.MailAuthority(mailAuthority.account(), mailAuthority.version() + 1);
      seen.add(take("mailWithStaleAuthority", outcome(managed.readMail(origin, custody, stale, feed, Map.of()))));
      seen.add(take("mailWithUnknownQuery", outcome(managed.readMail(origin, custody, mailAuthority, feed + "?unexpected=1", Map.of()))));
      seen.add(take("mailWithLease", outcome(managed.readMail(origin, custody, mailAuthority, feed + "?grantId=synthetic&timeMin=2026-11-23", Map.of()))));
      seen.add(take("inferenceWithKey", outcome(requests.send(origin, custody, "GET", models, Map.of(), null))));
      CloudRequests.Custody leased = custody;
      try (GoogleBrokerHost broker = GoogleBrokerHost.overDevice(origin, () -> leased, cache.toFile(), failure -> { throw failure; })) {
        String accounts = "/api/v1/eliza/google/accounts?side=owner";
        seen.add(take("brokerReadForOwner", GoogleBrokerJourney.read(broker.open(new AgentCredentials.Account(ACCOUNT.userId(), ACCOUNT.organizationId())), accounts)));
        seen.add(take("brokerReadForAnotherOwner", GoogleBrokerJourney.read(broker.open(new AgentCredentials.Account("user-2", ACCOUNT.organizationId())), accounts)));
      }
      seen.add(take("brokerBearers", String.join(",", cloud.brokerBearers)));
      cloud.families.get(cloud.families.size() - 1).ended = true;
      clock.addAndGet(16 * 60_000L);
      seen.add(take("mailAfterRevokedLease", outcome(requests.send(origin, custody, "GET", feed, Map.of(), null))));
      seen.add(take("bearers", String.join(",", cloud.mailBearers) + "/" + String.join(",", cloud.modelBearers)));
      seen.add(take("leaseReuses", cloud.reused.get()));

      if (!"SIGNED_IN".equals(signIn())) throw new IllegalStateException("Could not restore the original test account");
      var previous = requireMailAuthority(custody);
      String reviewedCredential = store.current().credentialId();
      cloud.beforeMailReply.set(() -> {
        store.signOut();
        if (!"SIGNED_IN".equals(signIn())) throw new IllegalStateException("Could not re-enroll the original test account");
      });
      seen.add(take("replyFromPreviousEnrollment", outcome(managed.readMail(origin, custody, previous, feed, Map.of()))));
      var reEnrolled = requireMailAuthority(custody);
      int sentModels = cloud.modelBearers.size();
      int sentMail = cloud.mailBearers.size();
      String currentCredential = store.current().credentialId();
      seen.add(take("boundPreviousCredential", outcome(requests.send("old", origin, custody, "GET", models, Map.of(), null, reviewedCredential))));
      seen.add(take("boundCurrentCredential", outcome(requests.send("current", origin, custody, "GET", models, Map.of(), null, currentCredential))));
      seen.add(take("boundCannotUseLease", outcome(requests.send("lease", origin, custody, "GET", feed, Map.of(), null, currentCredential))));
      seen.add(take("boundReachedOnlyReviewedKey", cloud.modelBearers.size() == sentModels + 1 && cloud.mailBearers.size() == sentMail));
      seen.add(take("sameOwnerReEnrolledAtNewVersion", previous.account().equals(reEnrolled.account()) && previous.version() < reEnrolled.version()));

      var beforeRenewal = store.current();
      String legacyBinding = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(beforeRenewal.value().getBytes(StandardCharsets.UTF_8)));
      String keySlot = DeviceCredentialStore.NAMESPACE + ":" + DeviceCredentialStore.authorityDigest(origin) + ":key:" + beforeRenewal.version();
      String written = slots.read(keySlot);
      String installed = written.replace(",\"binding\":" + CredentialJson.quote(legacyBinding), "");
      if (written.equals(installed)) throw new IllegalStateException("The test did not restore the pre-binding record shape");
      slots.write(keySlot, installed);
      seen.add(take("legacyVaultBindingMatches", legacyBinding.equals(store.accountBinding(beforeRenewal.value()))));

      cloud.beforeMailReply.set(() -> {
        clock.addAndGet(16 * DAY_MS);
        client.renewIfDue();
      });
      seen.add(take("replyFromBeforeRenewal", outcome(managed.readMail(origin, custody, reEnrolled, feed, Map.of()))));
      var renewed = requireMailAuthority(custody);
      seen.add(take("sameOwnerRenewedAtNewVersion", reEnrolled.account().equals(renewed.account()) && reEnrolled.version() < renewed.version()));
      seen.add(take("readAfterRenewal", outcome(managed.readMail(origin, custody, renewed, feed, Map.of()))));
      var restored = new DeviceCredentialStore(slots, DeviceCredentialStore.authorityDigest(origin), clock::get);
      seen.add(take("vaultBindingAfterRenewalRestart", legacyBinding.equals(restored.accountBinding(store.current().value()))
          && restored.accountBinding(beforeRenewal.value()) == null));
      clock.addAndGet(16 * 60_000L);
      cloud.beforeLeaseReply.set(() -> {
        store.signOut();
        if (!"SIGNED_IN".equals(signIn()) || store.readLease().stage() != DeviceCredentialStore.SessionRead.START_REFRESH) {
          throw new IllegalStateException("Could not start the new enrollment's refresh");
        }
      });
      boolean refusedOldAccess = lease.accessToken() == null;
      var afterRefresh = requireMailAuthority(custody);
      boolean newRefreshKept = CredentialPolicy.canLeaseRefreshAnswered(store.state(), afterRefresh.version());
      store.leaseUnanswered(afterRefresh.version());
      seen.add(take("refreshFromPreviousEnrollment", refusedOldAccess && newRefreshKept &&
          afterRefresh.version() > renewed.version() &&
          "200".equals(outcome(managed.readMail(origin, custody, afterRefresh, feed, Map.of())))));
      cloud.server.stop(0);
      return "{" + String.join(",", seen) + "}";
    } finally {
      try (var files = Files.walk(cache)) {
        for (Path file : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(file);
      }
    }
  }

  private static CloudRequests.MailAuthority requireMailAuthority(CloudRequests.Custody custody) {
    var scope = custody.mailAuthority();
    if (scope == null) throw new IllegalStateException("The original test owner has no mail scope");
    return scope;
  }

  private String signIn() {
    int attempt = store.beginSignIn();
    return client.exchange(attempt, BINDING, proof()).name();
  }

  private Proof proof() {
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    Answer<Grant> grant = client.connect(SESSION, BINDING, state, SignInPolicy.s256(verifier), "Journey phone");
    if (!(grant instanceof Answer.Answered<Grant> granted)) throw new IllegalStateException("connect " + grant);
    return new Proof(granted.value().code(), state, verifier);
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
    String successor = store.current().credentialId();
    String named = ",\"successor\":" + CredentialJson.quote(successor);
    String saved = slots.read(prefix + "credential");
    slots.write(prefix + "credential", saved.replace(named, "").replace(",\"lease\":false", named)
        .replace(",\"lease\":{\"tag\":\"NoLease\"}", ""));
    start();
    cloud.offline = true;
    client.settleDuties();
    cloud.offline = false;
    start();
    client.settleDuties();
    if (!cloud.revokeSuccessors.equals(List.of(successor, successor)) || !saved.contains(named)) {
      throw new IllegalStateException("Replacement must name its saved successor on retry after restart");
    }
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
    if (!cloud.revokeSuccessors.get(beforeRetry).isEmpty()) throw new IllegalStateException("Sign-out must not name a successor");
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

    seen.add(CredentialJson.quote("notices") + ":[" + String.join(",", notices) + "]");
    seen.add(leaseJourney(seen, prefix));
    Map<String, Integer> kinds = new HashMap<>();
    for (String slot : slots.held.keySet()) kinds.merge(slot.startsWith(prefix) ? "prefixed" : "other", 1, Integer::sum);
    seen.add(take("unprefixedSlots", kinds.getOrDefault("other", 0)));
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

  public static void main(String[] args) throws Exception {
    if (args.length == 1 && args[0].equals("browser")) System.out.println(browserReturn());
    else if (args.length == 1 && args[0].equals("cloud")) System.out.println(new DeviceKeyJourney().cloudJourney());
    else System.out.println(new DeviceKeyJourney().run());
    System.exit(0);
  }
}
