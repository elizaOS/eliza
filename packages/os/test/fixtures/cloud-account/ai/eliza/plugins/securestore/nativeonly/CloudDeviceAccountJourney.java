// spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device in and keep its key"; spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device out"; spec/cloud/identity/sessions.md, "Story: Stay signed in"; spec/os/signIn/browserReturn.md, "Story: Reconnect a signed-in device for mail and calendar"
package ai.eliza.plugins.securestore.nativeonly;

import android.content.Context;
import android.net.Uri;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.Key;
import java.security.KeyStoreSpi;
import java.security.MessageDigest;
import java.security.Provider;
import java.security.SecureRandom;
import java.security.Security;
import java.security.cert.Certificate;
import java.security.spec.AlgorithmParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import javax.crypto.KeyGeneratorSpi;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;

public final class CloudDeviceAccountJourney {
  private static final Map<String, SecretKey> KEYS = new ConcurrentHashMap<>();
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  private static final long LEASE_SECONDS = 90L * 24 * 60 * 60;
  private static final String CLIENT_ID = "com.example.consumer";
  private static final String SERVER_CLIENT = "123456-journey.apps.googleusercontent.com";
  private static final String ACCOUNT = "11111111-2222-4333-8444-555555555555";
  private static final String ORGANIZATION = "66666666-7777-4888-9999-000000000000";

  public static final class FakeKeyStore extends KeyStoreSpi {
    @Override public Key engineGetKey(String alias, char[] password) { return KEYS.get(alias); }
    @Override public boolean engineContainsAlias(String alias) { return KEYS.containsKey(alias); }
    @Override public void engineLoad(InputStream stream, char[] password) {}
    @Override public Certificate[] engineGetCertificateChain(String alias) { return null; }
    @Override public Certificate engineGetCertificate(String alias) { return null; }
    @Override public Date engineGetCreationDate(String alias) { return null; }
    @Override public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain) { throw new UnsupportedOperationException(); }
    @Override public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain) { throw new UnsupportedOperationException(); }
    @Override public void engineSetCertificateEntry(String alias, Certificate certificate) { throw new UnsupportedOperationException(); }
    @Override public void engineDeleteEntry(String alias) { KEYS.remove(alias); }
    @Override public Enumeration<String> engineAliases() { return Collections.enumeration(KEYS.keySet()); }
    @Override public int engineSize() { return KEYS.size(); }
    @Override public boolean engineIsKeyEntry(String alias) { return KEYS.containsKey(alias); }
    @Override public boolean engineIsCertificateEntry(String alias) { return false; }
    @Override public String engineGetCertificateAlias(Certificate certificate) { return null; }
    @Override public void engineStore(OutputStream stream, char[] password) { throw new UnsupportedOperationException(); }
  }

  public static final class FakeKeyGenerator extends KeyGeneratorSpi {
    private String alias;
    @Override protected void engineInit(SecureRandom random) { throw new UnsupportedOperationException(); }
    @Override protected void engineInit(int size, SecureRandom random) { throw new UnsupportedOperationException(); }
    @Override protected void engineInit(AlgorithmParameterSpec spec, SecureRandom random) {
      alias = ((android.security.keystore.KeyGenParameterSpec) spec).getKeystoreAlias();
    }
    @Override protected SecretKey engineGenerateKey() {
      byte[] bytes = new byte[32];
      RANDOM.nextBytes(bytes);
      SecretKey key = new SecretKeySpec(bytes, "AES");
      KEYS.put(alias, key);
      return key;
    }
  }

  private static final class Grant {
    final String key;
    final long expiresAt;
    final Grant replaces;
    final String credentialId = java.util.UUID.randomUUID().toString();
    boolean acknowledged, ended;
    Family family;
    Grant(String key, long expiresAt, Grant replaces) {
      this.key = key;
      this.expiresAt = expiresAt;
      this.replaces = replaces;
    }
  }

  private static final class Family {
    String refresh, access, offeredRefresh, offeredAccess;
    final List<String> spent = new ArrayList<>();
    boolean ended;
    Grant grant;
  }

  private record Reply(int status, String body, String location, boolean drop) {
    static Reply json(int status, JSONObject body) { return new Reply(status, body.toString(), null, false); }
    static Reply refused(String reason) { return json(401, new JSONObject().put("error", "authentication_required").put("reason", reason)); }
  }

  private record HeldRefusal(String path, CountDownLatch received, CountDownLatch release) {
    HeldRefusal(String path) { this(path, new CountDownLatch(1), new CountDownLatch(1)); }
  }

  private static final class Cloud {
    final List<Grant> grants = new ArrayList<>();
    final List<Family> families = new ArrayList<>();
    final List<String> leasePresented = new ArrayList<>();
    final List<String> revokes = new ArrayList<>();
    final List<String> mailSeen = new ArrayList<>();
    final List<String> paths = new ArrayList<>();
    int keySeconds;
    long leaseDelayMs;
    boolean dropNextLease, expireNextAccess, deviceEpochMoved, cookieOrOrigin;
    boolean offerLease = true, dropNextAcknowledgment;
    String exchangeAccount = ACCOUNT, exchangeOrganization = ORGANIZATION;
    int reuses;
    volatile HeldRefusal heldRefusal;
    Object advertisedMailLease = true;

    synchronized Reply answer(String method, String path, String query, String bearer, String body, Map<String, String> headers) throws Exception {
      long now = System.currentTimeMillis();
      paths.add(method + " " + path);
      switch (path) {
        case "/api/auth/device/exchange" -> {
          Grant grant = signedIn(now, offerLease);
          JSONObject response = new JSONObject().put("token", grant.key).put("expiresIn", keySeconds)
              .put("accountId", exchangeAccount).put("organizationId", exchangeOrganization);
          if (grant.family != null) response.put("lease", new JSONObject().put("refresh", grant.family.refresh).put("refreshExpiresIn", LEASE_SECONDS));
          return Reply.json(200, response);
        }
        case "/api/v1/app-auth/mobile/config" -> {
          return Reply.json(200, new JSONObject().put("clientId", CLIENT_ID).put("environment", "staging")
              .put("redirectUri", "https://app.example.test/android/auth/callback").putOpt("mailLease", advertisedMailLease)
              .put("google", new JSONObject().put("nativeSignIn", true).put("serverClientId", SERVER_CLIENT)
                .put("scopes", new JSONArray().put("openid"))));
        }
        case "/api/v1/auth/google/native/challenge" -> {
          return Reply.json(200, new JSONObject().put("challengeId", java.util.UUID.randomUUID().toString()).put("nonce", secret("", 43))
              .put("expiresAt", now + 300_000).put("serverClientId", SERVER_CLIENT));
        }
        case "/api/v1/app-auth/mobile/google" -> {
          Grant grant = signedIn(now, offerLease);
          JSONObject response = new JSONObject().put("status", "signed_in").put("secret", grant.key).put("credentialId", grant.credentialId)
              .put("user", new JSONObject().put("id", exchangeAccount)).put("organizationId", exchangeOrganization)
              .put("expiresAt", java.time.Instant.ofEpochMilli(grant.expiresAt).toString());
          if (grant.family != null) response.put("lease", new JSONObject().put("refresh", grant.family.refresh).put("refreshExpiresIn", LEASE_SECONDS));
          return Reply.json(200, response);
        }
        case "/api/auth/device/ack" -> {
          if (!acknowledge(grant(bearer))) return Reply.refused("credential_unknown");
          boolean drop = dropNextAcknowledgment;
          dropNextAcknowledgment = false;
          return new Reply(204, "", null, drop);
        }
        case "/api/v1/app-auth/mobile/ack" -> {
          JSONObject proof = new JSONObject(body);
          Grant grant = grant(proof.getString("secret"));
          boolean named = grant != null && grant.credentialId.equals(proof.getString("credentialId"));
          return named && acknowledge(grant) ? Reply.json(200, new JSONObject().put("status", "acknowledged")) : Reply.refused("credential_unknown");
        }
        case "/api/v1/api-keys/current" -> {
          Grant grant = grant(bearer);
          if (grant == null || grant.ended) return Reply.refused("credential_revoked");
          grant.ended = true;
          if (grant.family != null && grant.family.grant == grant) grant.family.ended = true;
          return new Reply(204, "", null, false);
        }
        case "/api/auth/device/lease", "/api/auth/device/renew", "/api/v1/app-auth/mobile/lease", "/api/v1/app-auth/mobile/renew" -> {
          boolean renew = path.endsWith("/renew"), canonical = path.startsWith("/api/v1/");
          if (!renew) leasePresented.add(bearer);
          Family family = family(bearer);
          if (family == null || !family.grant.acknowledged) return Reply.refused("credential_unknown");
          if (family.ended || family.grant.ended || deviceEpochMoved) return Reply.refused("credential_revoked");
          if (family.spent.contains(bearer)) {
            reuses++;
            family.ended = true;
            family.grant.ended = true;
            return Reply.refused("credential_revoked");
          }
          if (bearer.equals(family.offeredRefresh)) commit(family);
          if (renew) {
            Grant grant = new Grant(secret("eliza_mobile_", 43), now + 7L * 24 * 60 * 60 * 1000, family.grant);
            grants.add(grant);
            return Reply.json(200, new JSONObject().put(canonical ? "secret" : "token", grant.key).put("credentialId", grant.credentialId).put("expiresIn", 7L * 24 * 60 * 60));
          }
          family.offeredRefresh = secret("eliza_lease_refresh_", 54);
          family.offeredAccess = secret("eliza_lease_", 43);
          if (leaseDelayMs > 0) Thread.sleep(leaseDelayMs);
          Reply pair = Reply.json(200, new JSONObject().put("access", family.offeredAccess).put("accessExpiresIn", 900)
              .put("refresh", family.offeredRefresh).put("refreshExpiresIn", LEASE_SECONDS));
          if (!dropNextLease) return pair;
          dropNextLease = false;
          return new Reply(200, pair.body(), null, true);
        }
        case "/api/auth/device/revoke" -> {
          Grant grant = grant(bearer);
          Family family = grant == null ? family(bearer) : null;
          Reply reply;
          if (grant != null) {
            if (grant.ended || !grant.acknowledged || deviceEpochMoved) reply = Reply.refused("credential_revoked");
            else if (grant.expiresAt <= now) reply = Reply.refused("credential_expired");
            else {
              grant.ended = true;
              if (grant.family != null && grant.family.grant == grant) grant.family.ended = true;
              reply = new Reply(204, "", null, false);
            }
          } else if (family == null) reply = Reply.refused("credential_unknown");
          else if (family.ended || deviceEpochMoved || family.spent.contains(bearer)) reply = Reply.refused("credential_revoked");
          else {
            family.ended = true;
            family.grant.ended = true;
            reply = new Reply(204, "", null, false);
          }
          revokes.add((grant != null ? "key " : "lease ") + reply.status());
          return reply;
        }
        default -> {
          mailSeen.add(method + " " + path);
          if (headers.containsKey("cookie") || headers.containsKey("origin")) cookieOrOrigin = true;
          if (expireNextAccess) {
            expireNextAccess = false;
            return Reply.refused("credential_expired");
          }
          Family family = families.stream().filter((item) -> bearer != null && (bearer.equals(item.access) || bearer.equals(item.offeredAccess))).findFirst().orElse(null);
          if (family == null) return Reply.refused("credential_unknown");
          if (family.ended || family.grant.ended || deviceEpochMoved) return Reply.refused("credential_revoked");
          if (bearer.equals(family.offeredAccess)) commit(family);
          if (path.equals("/api/v1/eliza/google/accounts")) return new Reply(302, "", "https://elsewhere.example.test/", false);
          return Reply.json(200, new JSONObject().put("method", method).put("query", query == null ? "" : query)
              .put("idempotencyKey", headers.getOrDefault("idempotency-key", "")).put("ifMatch", headers.getOrDefault("if-match", ""))
              .put("body", body));
        }
      }
    }

    private Grant signedIn(long now, boolean withLease) {
      Grant grant = new Grant(secret("eliza_mobile_", 43), now + keySeconds * 1000L, null);
      if (withLease) {
        Family family = new Family();
        family.refresh = secret("eliza_lease_refresh_", 54);
        family.grant = grant;
        grant.family = family;
        families.add(family);
      }
      grants.add(grant);
      return grant;
    }

    private boolean acknowledge(Grant grant) {
      if (grant == null || grant.ended) return false;
      if (grant.acknowledged) return true;
      grant.acknowledged = true;
      if (grant.replaces != null) {
        grant.replaces.ended = true;
        grant.family = grant.replaces.family;
        grant.family.grant = grant;
      }
      return true;
    }

    private void commit(Family family) {
      family.spent.add(family.refresh);
      family.refresh = family.offeredRefresh;
      family.access = family.offeredAccess;
      family.offeredRefresh = null;
      family.offeredAccess = null;
    }

    Grant grant(String key) {
      return grants.stream().filter((item) -> item.key.equals(key)).findFirst().orElse(null);
    }

    Family family(String refresh) {
      return families.stream().filter((item) -> refresh != null && (refresh.equals(item.refresh) || refresh.equals(item.offeredRefresh) || item.spent.contains(refresh)))
          .findFirst().orElse(null);
    }

    Family latest() { return families.get(families.size() - 1); }
  }

  private static String secret(String prefix, int length) {
    StringBuilder value = new StringBuilder(prefix);
    for (int index = 0; index < length; index++) value.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
    return value.toString();
  }

  private static void serve(Cloud cloud, HttpExchange exchange) throws IOException {
    try (exchange) {
      String authorization = exchange.getRequestHeaders().getFirst("Authorization");
      String bearer = authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7) : null;
      Map<String, String> headers = new LinkedHashMap<>();
      exchange.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(java.util.Locale.ROOT), values.get(0)));
      String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      String path = exchange.getRequestURI().getRawPath();
      HeldRefusal refusal = cloud.heldRefusal;
      Reply reply;
      if (refusal != null && refusal.path().equals(path)) {
        cloud.heldRefusal = null;
        refusal.received().countDown();
        if (!refusal.release().await(30, TimeUnit.SECONDS)) throw new IOException("No new enrollment while refusal was held");
        reply = Reply.refused("credential_revoked");
      } else {
        reply = cloud.answer(exchange.getRequestMethod(), path, exchange.getRequestURI().getRawQuery(), bearer, body, headers);
      }
      if (reply.location() != null) exchange.getResponseHeaders().set("Location", reply.location());
      byte[] bytes = reply.body().getBytes(StandardCharsets.UTF_8);
      if (reply.status() == 204 || reply.status() == 302) {
        if (!reply.drop()) exchange.sendResponseHeaders(reply.status(), -1);
        return;
      }
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      int sent = reply.drop() ? bytes.length / 2 : bytes.length;
      exchange.sendResponseHeaders(reply.status(), sent);
      exchange.getResponseBody().write(bytes, 0, sent);
    } catch (IOException dropped) {
      return;
    } catch (Exception failure) {
      throw new IOException(failure);
    }
  }

  private static boolean signIn(CloudDeviceAccount account) throws Exception {
    return finishBrowserSignIn(account, account.begin());
  }

  private static boolean finishBrowserSignIn(CloudDeviceAccount account, Uri start) throws Exception {
    String state = start.getQueryParameter("device_state");
    return account.exchange(Uri.parse("https://app.example.test/android/auth/callback?code=" + secret("", 43) + "&state=" + state));
  }

  private static CloudDeviceAccount deviceAccount(File home) {
    return new CloudDeviceAccount(new Context() {
      @Override public File getNoBackupFilesDir() { return home; }
    }, "https://app.example.test", "https://cloud.example.test", "/android/auth/callback");
  }

  private static void upgradeLegacyAccount(CloudDeviceAccount account, Cloud cloud, File home, boolean googleEnrollment) throws Exception {
    cloud.keySeconds = 60;
    cloud.offerLease = false;
    boolean enrolled = googleEnrollment
        ? account.finishNativeGoogle(account.prepareNativeGoogle(CLIENT_ID, "staging"), "header.payload.signature", null)
        : signIn(account);
    if (!enrolled || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.REQUIRED) {
      throw new AssertionError("Legacy sign-in did not request a mail lease upgrade");
    }
    String original = account.session().token();
    for (Object priorConfig : new Object[] { null, false, "true" }) {
      cloud.advertisedMailLease = priorConfig;
      if (account.leaseUpgradeAvailable(CLIENT_ID, "staging") || !"email".equals(account.hostedView("email").getEncodedFragment()))
        throw new AssertionError("A host without lease support did not keep the browser path");
      try {
        account.beginLeaseUpgrade(CLIENT_ID, "staging");
        throw new AssertionError("The device asked for an unsupported upgrade");
      } catch (IllegalStateException expected) {
        if (account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.REQUIRED)
          throw new AssertionError("The unsupported upgrade left a pending attempt");
      }
    }
    cloud.advertisedMailLease = true;
    if (!account.leaseUpgradeAvailable(CLIENT_ID, "staging") || account.leaseUpgradeAvailable("com.other.consumer", "staging"))
      throw new AssertionError("The offer was not scoped to the exact registration");
    Uri outdated = account.beginLeaseUpgrade(CLIENT_ID, "staging");
    cloud.advertisedMailLease = false;
    int exchanges = Collections.frequency(cloud.paths, "POST /api/auth/device/exchange");
    if (finishBrowserSignIn(account, outdated) || exchanges != Collections.frequency(cloud.paths, "POST /api/auth/device/exchange")
        || !original.equals(account.session().token()) || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.REQUIRED)
      throw new AssertionError("A rollback did not restore the previous account and hosted view");
    cloud.advertisedMailLease = true;
    Uri canceled = account.beginLeaseUpgrade(CLIENT_ID, "staging");
    if (account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.SIGN_IN_PENDING
        || !canceled.toString().equals(account.beginLeaseUpgrade(CLIENT_ID, "staging").toString())) {
      throw new AssertionError("Repeated presses did not keep the same browser attempt");
    }
    account.cancelLeaseUpgrade(canceled);
    if (finishBrowserSignIn(account, canceled) || !original.equals(account.session().token())) {
      throw new AssertionError("A canceled upgrade changed the current account");
    }
    Uri withoutLease = account.beginLeaseUpgrade(CLIENT_ID, "staging");
    account.cancelLeaseUpgrade(canceled);
    if (account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.SIGN_IN_PENDING
        || finishBrowserSignIn(account, withoutLease)) {
      throw new AssertionError("A stale cancellation or an upgrade without a lease was accepted");
    }
    cloud.offerLease = true;
    cloud.exchangeAccount = ORGANIZATION;
    if (finishBrowserSignIn(account, account.beginLeaseUpgrade(CLIENT_ID, "staging")) || !original.equals(account.session().token())
        || cloud.latest().grant.acknowledged || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.REQUIRED) {
      throw new AssertionError("A different account completed the upgrade");
    }
    cloud.exchangeAccount = ACCOUNT;
    cloud.exchangeOrganization = ACCOUNT;
    if (finishBrowserSignIn(account, account.beginLeaseUpgrade(CLIENT_ID, "staging")) || !original.equals(account.session().token())
        || cloud.latest().grant.acknowledged) {
      throw new AssertionError("A different organization completed the upgrade");
    }
    cloud.exchangeOrganization = ORGANIZATION;
    cloud.dropNextAcknowledgment = true;
    try {
      finishBrowserSignIn(account, account.beginLeaseUpgrade(CLIENT_ID, "staging"));
      throw new AssertionError("The acknowledgment should have been lost");
    } catch (IOException expected) {
      if (!original.equals(account.session().token()) || cloud.grant(original).ended
          || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.ACKNOWLEDGMENT_PENDING) {
        throw new AssertionError("The old credential did not survive the lost acknowledgment");
      }
    }
    account = deviceAccount(home);
    if (!account.finishAcknowledgment() || original.equals(account.session().token())
        || !ACCOUNT.equals(account.session().accountId()) || !ORGANIZATION.equals(account.session().organizationId())
        || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.NOT_REQUIRED || status(account) != 200) {
      throw new AssertionError("The authorized owner did not finish the upgrade");
    }
    account.retryRevocation();
    if (!cloud.grant(original).ended) throw new AssertionError("The replaced key did not retire");
    account.clear();
    account.retryRevocation();
  }

  private static void upgradeLegacyAccountWithNativeGoogle(CloudDeviceAccount account, Cloud cloud) throws Exception {
    cloud.keySeconds = 60;
    cloud.offerLease = false;
    if (!signIn(account)) throw new AssertionError("The legacy account could not sign in");
    String original = account.session().token();
    String proof = "header.payload.signature";
    String challenge = "POST /api/v1/auth/google/native/challenge";
    String signIn = "POST /api/v1/app-auth/mobile/google";
    int challenges = Collections.frequency(cloud.paths, challenge);
    cloud.advertisedMailLease = false;
    if (account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging") != null || challenges != Collections.frequency(cloud.paths, challenge))
      throw new AssertionError("The device opened a picker for a missing lease offer");
    cloud.advertisedMailLease = true;
    var canceled = account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging");
    if (account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.SIGN_IN_PENDING)
      throw new AssertionError("The native picker is not reported as pending");
    try {
      account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging");
      throw new AssertionError("A pending native upgrade was replaced");
    } catch (IllegalStateException expected) { }
    account.cancelLeaseUpgrade();
    int exchanges = Collections.frequency(cloud.paths, signIn);
    if (account.finishNativeGoogle(canceled, proof, null) || exchanges != Collections.frequency(cloud.paths, signIn))
      throw new AssertionError("A canceled native picker result reached sign-in");
    var withdrawn = account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging");
    cloud.advertisedMailLease = false;
    if (account.finishNativeGoogle(withdrawn, proof, null) || exchanges != Collections.frequency(cloud.paths, signIn))
      throw new AssertionError("A withdrawn lease offer reached sign-in");
    cloud.advertisedMailLease = true;
    if (account.finishNativeGoogle(account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging"), proof, null)
        || !original.equals(account.session().token()) || exchanges + 1 != Collections.frequency(cloud.paths, signIn)
        || cloud.grants.get(cloud.grants.size() - 1).acknowledged)
      throw new AssertionError("A key without a lease replaced the current owner");
    cloud.offerLease = true;
    for (String other : List.of("account", "organization")) {
      cloud.exchangeAccount = "account".equals(other) ? ORGANIZATION : ACCOUNT;
      cloud.exchangeOrganization = "organization".equals(other) ? ACCOUNT : ORGANIZATION;
      if (account.finishNativeGoogle(account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging"), proof, null)
          || !original.equals(account.session().token()) || cloud.latest().grant.acknowledged
          || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.REQUIRED)
        throw new AssertionError("A different " + other + " was acknowledged during native upgrade");
    }
    cloud.exchangeAccount = ACCOUNT;
    cloud.exchangeOrganization = ORGANIZATION;
    if (!account.finishNativeGoogle(account.prepareNativeGoogleLeaseUpgrade(CLIENT_ID, "staging"), proof, null)
        || original.equals(account.session().token()) || !ACCOUNT.equals(account.session().accountId())
        || !ORGANIZATION.equals(account.session().organizationId())
        || account.leaseUpgradeStatus() != CloudDeviceAccount.LeaseUpgradeStatus.NOT_REQUIRED || status(account) != 200)
      throw new AssertionError("The same owner did not gain native mail access");
    account.retryRevocation();
    if (!cloud.grant(original).ended) throw new AssertionError("The replaced key did not retire");
    account.clear();
    account.retryRevocation();
  }

  private static int duties(File directory) throws Exception {
    String stored = new JsonCredentialSlots(directory, "eliza-cloud-device-account.v1", (slot) -> 2048).read("revoke");
    return stored == null ? 0 : new JSONObject(stored).getJSONArray("duties").length();
  }

  private static int status(CloudDeviceAccount account) throws Exception {
    return account.mailRequest("GET", "/api/v1/eliza/google/status", null, null, null, null).status();
  }

  private static boolean reEnrollDuringRefusal(CloudDeviceAccount account, Cloud cloud, File slots, boolean renew) throws Exception {
    cloud.keySeconds = 60;
    if (!signIn(account)) throw new AssertionError("Initial enrollment failed");
    if (renew) {
      JsonCredentialSlots secure = new JsonCredentialSlots(slots, "eliza-cloud-device-account.v1", (slot) -> 2048);
      JSONObject credential = new JSONObject(secure.read("credential"));
      credential.put("issuedAt", credential.getLong("expiresAt") - TimeUnit.MINUTES.toMillis(3));
      secure.write("credential", credential.toString());
    }
    HeldRefusal refusal = new HeldRefusal(renew ? "/api/auth/device/renew" : "/api/auth/device/lease");
    cloud.heldRefusal = refusal;
    FutureTask<Boolean> oldWork = new FutureTask<>(() -> renew ? account.renewIfDue() : account.leaseAccess() != null);
    new Thread(oldWork).start();
    CloudDeviceAccount.MailAuthority current;
    try {
      if (!refusal.received().await(30, TimeUnit.SECONDS)) throw new AssertionError("The previous enrollment did not reach Cloud");
      account.clear();
      if (!signIn(account)) throw new AssertionError("New enrollment failed");
      current = account.mailAuthority();
    } finally {
      refusal.release().countDown();
    }
    boolean retained = !oldWork.get(30, TimeUnit.SECONDS) && current != null && current.equals(account.mailAuthority())
        && account.readMail(current, "/api/v1/eliza/google/status", null).status() == 200;
    account.clear();
    account.retryRevocation();
    return retained;
  }

  public static void main(String[] arguments) throws Exception {
    System.setProperty("sun.net.http.retryPost", "false");
    Security.addProvider(new Provider("AndroidKeyStore", "1.0", "Journey keystore") {
      {
        put("KeyStore.AndroidKeyStore", FakeKeyStore.class.getName());
        put("KeyGenerator.AES", FakeKeyGenerator.class.getName());
      }
    });
    Cloud cloud = new Cloud();
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/", (exchange) -> serve(cloud, exchange));
    server.setExecutor(Executors.newCachedThreadPool());
    server.start();
    int port = server.getAddress().getPort();
    URL.setURLStreamHandlerFactory((protocol) -> !"https".equals(protocol) ? null : new URLStreamHandler() {
      @Override protected URLConnection openConnection(URL url) throws IOException {
        if (!"cloud.example.test".equals(url.getHost()) || url.getPort() != -1) throw new IOException("Unexpected cloud host " + url.getHost());
        return new URL("http", "127.0.0.1", port, url.getFile()).openConnection();
      }
    });
    File home = Files.createTempDirectory("cloud-device-account").toFile();
    File slots = new File(home, "eliza-cloud-device-account");
    CloudDeviceAccount account = deviceAccount(home);
    Map<String, Object> seen = new LinkedHashMap<>();

    cloud.keySeconds = 6;
    seen.put("signedIn", signIn(account));
    long signedInAt = System.currentTimeMillis();
    String firstKey = account.session().token();
    String legacyBinding = Base64.getUrlEncoder().withoutPadding().encodeToString(
      MessageDigest.getInstance("SHA-256").digest(firstKey.getBytes(StandardCharsets.UTF_8)));
    seen.put("legacyVaultBindingMatches", legacyBinding.equals(account.accountBinding(firstKey)));
    seen.put("renewedBeforeHalfLife", account.renewIfDue());

    cloud.leaseDelayMs = 300;
    ExecutorService readers = Executors.newFixedThreadPool(4);
    CountDownLatch go = new CountDownLatch(1);
    List<Future<String>> reads = new ArrayList<>();
    for (int index = 0; index < 4; index++) reads.add(readers.submit(() -> { go.await(); return account.leaseAccess(); }));
    go.countDown();
    Set<String> tokens = new HashSet<>();
    for (Future<String> read : reads) tokens.add(read.get());
    readers.shutdown();
    cloud.leaseDelayMs = 0;
    seen.put("refreshesForFourReaders", cloud.leasePresented.size());
    seen.put("readersShareOneAccess", tokens.size() == 1 && !tokens.contains(null));

    var authority = account.mailAuthority();
    if (authority == null) throw new AssertionError("The acknowledged lease did not give its owner a read scope");
    String feed = "/api/v1/eliza/google/calendar/feed";
    var stale = new CloudDeviceAccount.MailAuthority(authority.accountId(), authority.organizationId(), "stale");
    boolean refusedStale = false;
    boolean refusedQuery = false;
    try { account.readMail(stale, feed, null); }
    catch (IllegalStateException changed) { refusedStale = true; }
    try { account.readMail(authority, feed, new JSONObject().put("unexpected", 1)); }
    catch (IllegalArgumentException invalid) { refusedQuery = true; }
    seen.put("scopedMailRead", List.of(refusedStale, refusedQuery,
        account.readMail(authority, feed, new JSONObject().put("grantId", "synthetic")).status()));

    var search = account.mailRequest("GET", "/api/v1/eliza/google/gmail/search", new JSONObject().put("q", "from:anna is:unread").put("limit", 10), null, null, null);
    seen.put("search", search.status() + " " + new JSONObject(search.body()).getString("query"));
    var created = account.mailRequest("POST", "/api/v1/eliza/google/calendar/events", null, new JSONObject().put("summary", "Tea"), "tea-2026-11-22", null);
    JSONObject echoed = new JSONObject(created.body());
    seen.put("created", created.status() + " " + echoed.getString("idempotencyKey") + " " + echoed.getString("body"));
    var deleted = account.mailRequest("DELETE", "/api/v1/eliza/google/gmail/drafts/r-123", null, null, null, "\"v7\"");
    seen.put("deleted", deleted.status() + " " + new JSONObject(deleted.body()).getString("ifMatch"));
    var moved = account.mailRequest("GET", "/api/v1/eliza/google/accounts", new JSONObject().put("side", "owner"), null, null, null);
    seen.put("redirectNotFollowed", moved.status() == 302 && cloud.mailSeen.stream().filter((item) -> item.endsWith("/accounts")).count() == 1);
    int refused = 0;
    for (String[] route : new String[][] {
        { "POST", "/api/v1/eliza/google/connect/native" }, { "GET", "/api/v1/billing/subscription" },
        { "GET", "/api/v1/eliza/google/gmail/read/../../../billing" }, { "POST", "/api/auth/device/lease" }, { "PUT", "/api/v1/eliza/google/status" } }) {
      try {
        account.mailRequest(route[0], route[1], null, null, null, null);
      } catch (IllegalArgumentException outsideAllowList) {
        refused++;
      }
    }
    seen.put("refusedRoutes", refused);

    int before = cloud.leasePresented.size();
    cloud.expireNextAccess = true;
    cloud.dropNextLease = true;
    boolean lost = false;
    try {
      status(account);
    } catch (IOException | org.json.JSONException lostReply) {
      lost = true;
    }
    int afterLoss = status(account);
    List<String> presented = cloud.leasePresented.subList(before, cloud.leasePresented.size());
    seen.put("lostReply", new JSONArray().put(lost).put(presented.size() == 2 && presented.get(0).equals(presented.get(1))).put(afterLoss).put(cloud.reuses));

    long wait = signedInAt + 3100 - System.currentTimeMillis();
    if (wait > 0) Thread.sleep(wait);
    seen.put("renewedAfterHalfLife", account.renewIfDue());
    String secondKey = account.session().token();
    CloudDeviceAccount reopened = deviceAccount(home);
    seen.put("vaultBindingAfterRenewalRestart", legacyBinding.equals(reopened.accountBinding(secondKey))
        && reopened.accountBinding(firstKey) == null && !authority.epoch().equals(reopened.mailAuthority().epoch()));
    Grant first = cloud.grant(firstKey);
    seen.put("renewal", new JSONArray().put(!secondKey.equals(firstKey)).put(first.ended).put(first.family.grant.key.equals(secondKey)).put(duties(slots)));
    account.retryRevocation();
    seen.put("afterRenewal", new JSONArray().put(duties(slots)).put(status(account)).put(cloud.reuses));

    cloud.deviceEpochMoved = true;
    int answered = status(account);
    seen.put("signedOut", new JSONArray().put(answered).put(account.session() == null).put(account.isDeviceOnly()).put(account.leaseAccess() == null).put(duties(slots)));
    account.retryRevocation();
    seen.put("dutiesAfterRefusedRevoke", duties(slots));
    cloud.deviceEpochMoved = false;

    cloud.keySeconds = 1;
    seen.put("signedInAgain", signIn(account));
    Thread.sleep(1300);
    seen.put("leaseOutlivesKey", new JSONArray().put(account.session() == null).put(account.leaseAccess() != null));
    account.clear();
    account.retryRevocation();
    Family last = cloud.latest();
    seen.put("lapsedKeyRevokedByLease", new JSONArray().put(cloud.revokes.get(cloud.revokes.size() - 1)).put(last.ended).put(last.grant.ended).put(duties(slots)));

    cloud.keySeconds = 6;
    int nativeFrom = cloud.paths.size();
    CloudDeviceAccount.NativeGoogleAttempt attempt = account.prepareNativeGoogle(CLIENT_ID, "staging");
    if (attempt.expiresAt() > System.currentTimeMillis() + 120_000L)
      throw new AssertionError("The Cloud challenge must not extend the tablet's pending sign-in");
    seen.put("nativeSignedIn", account.finishNativeGoogle(attempt, "header.payload.signature", null));
    long nativeAt = System.currentTimeMillis();
    String nativeKey = account.session().token();
    seen.put("nativeMail", status(account));
    Thread.sleep(Math.max(0, nativeAt + 3100 - System.currentTimeMillis()));
    account.maintainLease();
    String nativeSuccessor = account.session().token();
    seen.put("nativeRenewed", !nativeSuccessor.equals(nativeKey));
    Grant nativeFirst = cloud.grant(nativeKey);
    seen.put("nativeRenewal", new JSONArray().put(!nativeSuccessor.equals(nativeKey)).put(nativeFirst.ended).put(nativeFirst.family.grant.key.equals(nativeSuccessor)).put(status(account)));
    account.clear();
    account.retryRevocation();
    Grant nativeLast = cloud.grant(nativeSuccessor);
    seen.put("nativeSignedOut", new JSONArray().put(nativeLast.ended).put(nativeLast.family.ended).put(duties(slots)));
    seen.put("nativeNeverUsedWorkerRoutes", cloud.paths.subList(nativeFrom, cloud.paths.size()).stream().noneMatch((item) -> item.contains(" /api/auth/")));
    seen.put("cookieOrOrigin", cloud.cookieOrOrigin);
    upgradeLegacyAccount(account, cloud, home, false);
    upgradeLegacyAccount(account, cloud, home, true);
    upgradeLegacyAccountWithNativeGoogle(account, cloud);
    seen.put("newEnrollmentSurvivedLateRefreshRefusal", reEnrollDuringRefusal(account, cloud, slots, false));
    seen.put("newEnrollmentSurvivedLateRenewalRefusal", reEnrollDuringRefusal(account, cloud, slots, true));

    server.stop(0);
    System.out.println(new JSONObject(seen));
    System.exit(0);
  }
}
