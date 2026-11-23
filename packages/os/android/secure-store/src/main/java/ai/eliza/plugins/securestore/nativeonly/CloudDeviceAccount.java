package ai.eliza.plugins.securestore.nativeonly;

import android.content.Context;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class CloudDeviceAccount {
 private static final Pattern OPAQUE = Pattern.compile("[A-Za-z0-9._~-]{43,128}");
 private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
 private static final Object LOCK = new Object();
 private static final long PENDING_MS = 15 * 60_000L;
 private static final long MAX_CREDENTIAL_SECONDS = 7 * 24 * 60 * 60L;
 private static final long MAX_DEVICE_KEY_MS = 90 * 24 * 60 * 60_000L;
 private static final String CHALLENGE = "/api/v1/auth/google/native/challenge";
 private static final String SIGN_IN = "/api/v1/app-auth/mobile/google";
 private static final String ACKNOWLEDGE = "/api/v1/app-auth/mobile/ack";
 private static final String SIGN_OUT = "/api/v1/api-keys/current";
 private static final String LEASE_PATH = "/api/v1/app-auth/mobile/lease";
 private static final String RENEW = "/api/v1/app-auth/mobile/renew";
 private static final long MAX_LEASE_SECONDS = 90 * 24 * 60 * 60L;
 private static final long MAX_ACCESS_SECONDS = 15 * 60L;
 private static final long ACCESS_MARGIN_MS = 30_000L;
 private static final int MAX_DUTIES = 4;
 private static final int MAIL_REQUEST_BYTES = 32_768;
 private static final int MAIL_RESPONSE_BYTES = 4 * ((8 * 1024 * 1024 + 2) / 3) + 16_384;
 private static final Pattern LEASE_REFRESH = Pattern.compile("eliza_lease_refresh_[A-Za-z0-9_-]{54}");
 private static final Pattern LEASE_ACCESS = Pattern.compile("eliza_lease_[A-Za-z0-9_-]{43}");
 private static final String SEGMENT = "/[A-Za-z0-9_-]{1,256}";
 private static final Map<String, Pattern> MAIL_ROUTES = Map.of(
     "GET", Pattern.compile("/api/v1/eliza/(?:google/(?:status|accounts|calendar/(?:feed|calendars|events" + SEGMENT + ")|gmail/(?:triage|search|read|contacts|inbox-v1/(?:capabilities|thread|drafts|draft|attachment|operations" + SEGMENT + ")))|connections/sessions" + SEGMENT + ")"),
     "POST", Pattern.compile("/api/v1/eliza/(?:google/(?:disconnect|connect/initiate|calendar/events|gmail/(?:drafts|inbox-v1/operations(?:" + SEGMENT + "/dispatch)?))|connections/google/sessions)"),
     "PATCH", Pattern.compile("/api/v1/eliza/google/calendar/events" + SEGMENT),
     "DELETE", Pattern.compile("/api/v1/eliza/(?:google/(?:gmail/drafts|calendar/events)|connections/sessions)" + SEGMENT));
 private static final Object LEASE = new Object();
 private static Access access;
 private static final String PENDING = "pending";
 private static final String CREDENTIAL = "credential";
 private static final String REVOKE = "revoke";
 private static final String ACK = "awaiting-ack";
 private final Uri browser;
 private final URI cloud;
 private final Uri callback;
 private final JsonCredentialSlots slots;
 public record Session(String token, String accountId, String organizationId) {
  @Override public String toString() { return "CloudDeviceAccount.Session"; }
 }
 public record MailResponse(int status, String body) {
  @Override public String toString() { return "CloudDeviceAccount.MailResponse(" + status + ")"; }
 }
 private record Access(String token, long expiresAt, String mintedBy) {
  @Override public String toString() { return "CloudDeviceAccount.Access"; }
 }

 public CloudDeviceAccount(Context host, String browserOrigin, String cloudOrigin, String callbackPath) {
  browser = Uri.parse(origin(browserOrigin).toString());
  cloud = origin(cloudOrigin);
  if (!callbackPath.matches("(?:/[a-z][a-z0-9-]*)+")) throw new IllegalArgumentException("Invalid callback path");
  callback = browser.buildUpon().path(callbackPath).build();
  slots = new JsonCredentialSlots(new File(host.getNoBackupFilesDir(), "eliza-cloud-device-account"), "eliza-cloud-device-account.v1", slot -> 2048);
 }

 static URI origin(String input) {
  URI result = URI.create(input);
  if (!"https".equals(result.getScheme()) || result.getHost() == null || result.getRawUserInfo() != null
      || result.getPort() != -1 || result.getRawQuery() != null || result.getRawFragment() != null
      || !result.getPath().isEmpty()) throw new IllegalArgumentException("Account origin must be an HTTPS origin");
  return result;
 }

 public Uri manageAccount() {
  return browser.buildUpon().path("/").fragment("account").build();
 }

 public Uri hostedView(String view) throws Exception {
  if (!"email".equals(view) && !"calendar".equals(view)) throw new IllegalArgumentException("Unknown hosted account view");
  Uri.Builder target = browser.buildUpon().path("/").fragment(view);
  Session account = session();
  if (account != null) {
   byte[] hash = MessageDigest.getInstance("SHA-256").digest(account.accountId().getBytes(StandardCharsets.UTF_8));
   StringBuilder hex = new StringBuilder(64);
   for (byte value : hash) hex.append(Character.forDigit((value & 255) >> 4, 16)).append(Character.forDigit(value & 15, 16));
   target.appendQueryParameter("owner_hint", hex.toString());
  }
  return target.build();
 }

 public record SpeechSession(String sessionId, String token, String expiresAt, String wsUrl) {
  @Override public String toString() { return "CloudDeviceAccount.SpeechSession"; }
 }

 public SpeechSession startSpeech() throws Exception {
  String credential = requireCredential();
  JSONObject consent = new JSONObject(post("/api/v1/voice/speech/consent", new JSONObject(), credential, 200).body());
  String nonce = identifier(consent, "consentNonce");
  JSONObject session = new JSONObject(post("/api/v1/voice/speech/session", new JSONObject().put("consentNonce", nonce), credential, 200).body());
  String id = identifier(session, "sessionId");
  String token = session.getString("token"), expiresAt = session.getString("expiresAt"), url = session.getString("wsUrl");
  URI socket = URI.create(url);
  if (session.getInt("version") != 1 || !opaque(token) || !"wss".equals(socket.getScheme())
      || !cloud.getHost().equals(socket.getHost()) || socket.getPort() != -1
      || socket.getRawUserInfo() != null || socket.getRawFragment() != null
      || !"/api/v1/voice/speech/ws".equals(socket.getRawPath()) || !("sessionId=" + id).equals(socket.getRawQuery())
      || !java.time.Instant.parse(expiresAt).isAfter(java.time.Instant.now()))
   throw new IOException("Invalid Cloud speech session");
  return new SpeechSession(id, token, expiresAt, url);
 }

 public void stopSpeech(String sessionId) throws Exception {
  if (sessionId == null || !ID.matcher(sessionId).matches()) throw new IllegalArgumentException("Invalid speech session");
  JSONObject response = new JSONObject(post("/api/v1/voice/speech/session/" + sessionId + "/revoke", null, requireCredential(), 200).body());
  if (!response.getBoolean("revoked")) throw new IOException("Cloud speech session was not retired");
 }

 private String requireCredential() throws Exception {
  String credential = credential();
  if (credential == null) throw new IllegalStateException("No account is signed in");
  return credential;
 }

 public record NativeGoogleAttempt(String clientId, String environment, String serverClientId, List<String> scopes, String challengeId,
    String nonce, String state, long expiresAt) {
  @Override public String toString() { return "CloudDeviceAccount.NativeGoogleAttempt"; }
 }

 private JSONObject mobileClient(String clientId, String environment) throws Exception {
  if (!clientId.matches("[A-Za-z0-9_.-]{1,140}") || !environment.matches("[A-Za-z0-9_-]{1,32}"))
   throw new IllegalArgumentException("Invalid native client");
  return new JSONObject().put("clientId", clientId).put("environment", environment).put("redirectUri", callback.toString());
 }

 public NativeGoogleAttempt prepareNativeGoogle(String clientId, String environment) throws Exception {
  JSONObject client = mobileClient(clientId, environment);
  String query = new Uri.Builder().appendQueryParameter("clientId", clientId).appendQueryParameter("environment", environment)
      .appendQueryParameter("redirectUri", callback.toString()).build().getEncodedQuery();
  JSONObject config = new JSONObject(send("GET", "/api/v1/app-auth/mobile/config?" + query, null, null, 200).body());
  JSONObject google = config.optJSONObject("google");
  if (google == null || !google.optBoolean("nativeSignIn")) return null;
  String serverClientId = google.getString("serverClientId");
  if (!serverClientId.matches("[A-Za-z0-9-]{1,100}\\.apps\\.googleusercontent\\.com"))
   throw new IOException("Invalid Google client configuration");
  List<String> scopes = new ArrayList<>();
  JSONArray listed = google.optJSONArray("scopes");
  for (int index = 0; listed != null && index < listed.length(); index++) {
   String scope = listed.getString(index);
   if (!scope.matches("openid|email|https://www\\.googleapis\\.com/auth/[a-z.]{1,64}")) throw new IOException("Invalid Google scope");
   scopes.add(scope);
  }
  JSONObject pending = beginPending("google", 120_000L);
  String state = pending.getString("state");
  try {
   JSONObject response = new JSONObject(post(CHALLENGE,
       client.put("codeChallenge", challenge(pending)).put("codeChallengeMethod", "S256"), null, 200).body());
   String challengeId = identifier(response, "challengeId"), nonce = response.getString("nonce");
   long due = response.getLong("expiresAt"), now = System.currentTimeMillis();
   if (!opaque(nonce) || due <= now || due > now + 120_000L || !serverClientId.equals(response.getString("serverClientId")))
    throw new IOException("Invalid Google challenge");
   long expiry = Math.min(pending.getLong("expiresAt"), due);
   return new NativeGoogleAttempt(clientId, environment, serverClientId, List.copyOf(scopes), challengeId, nonce, state, expiry);
  } catch (Exception failure) {
   clearNativeGoogle(state);
   throw failure;
  }
 }

 public boolean finishNativeGoogle(NativeGoogleAttempt attempt, String idToken, String serverAuthCode) throws Exception {
  if (idToken == null || idToken.length() > 7500 || !idToken.matches("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"))
   throw new IOException("Invalid Google result");
  String snapshot = pendingSnapshot(attempt.state(), "google");
  if (snapshot == null || attempt.expiresAt() <= System.currentTimeMillis()) return false;
  String verifier = new JSONObject(snapshot).getString("verifier");
  JSONObject request = mobileClient(attempt.clientId(), attempt.environment()).put("state", attempt.state()).put("codeVerifier", verifier)
      .put("identity", new JSONObject().put("challengeId", attempt.challengeId()).put("idToken", idToken).put("codeVerifier", verifier));
  if (serverAuthCode != null && serverAuthCode.matches("[A-Za-z0-9/_.~-]{10,2048}")) request.put("serverAuthCode", serverAuthCode);
  JSONObject response = new JSONObject(post(SIGN_IN, request, null, 200).body());
  if (!"signed_in".equals(response.optString("status"))) {
   clearNativeGoogle(attempt.state());
   return false;
  }
  return keepDeviceKey(response, snapshot);
 }

 private boolean keepDeviceKey(JSONObject response, String snapshot) throws Exception {
  JSONObject pending = new JSONObject(snapshot);
  String secret = response.getString("secret");
  String credentialId = identifier(response, "credentialId");
  String accountId = identifier(response.getJSONObject("user"), "id"), organizationId = identifier(response, "organizationId");
  long expiresAt = java.time.Instant.parse(response.getString("expiresAt")).toEpochMilli(), now = System.currentTimeMillis();
  if (!opaque(secret) || expiresAt <= now || expiresAt > now + MAX_DEVICE_KEY_MS) throw new IOException("Invalid device key response");
  JSONObject key = new JSONObject().put("token", secret).put("credentialId", credentialId).put("accountId", accountId)
      .put("organizationId", organizationId).put("issuedAt", now).put("expiresAt", expiresAt);
  JSONObject offered = response.optJSONObject("lease");
  if (offered != null) key.put("lease", new JSONObject().put("refresh", leaseRefresh(offered, "refresh"))
      .put("refreshExpiresAt", now + leaseSeconds(offered, "refreshExpiresIn", MAX_LEASE_SECONDS) * 1000));
  synchronized (LOCK) {
   if (snapshot.equals(slots.read(PENDING)) && pendingActive(pending)) {
    slots.write(ACK, key.toString());
    slots.remove(PENDING);
   } else {
    oweRevocation(duty(key));
    return false;
   }
  }
  return finishAcknowledgment();
 }

 public void cancelNativeGoogle(NativeGoogleAttempt attempt) throws Exception {
  clearNativeGoogle(attempt.state());
 }

 private void clearNativeGoogle(String state) throws Exception {
  synchronized (LOCK) {
   String saved = slots.read(PENDING);
   if (saved == null) return;
   JSONObject pending = new JSONObject(saved);
   if ("google".equals(pending.optString("method")) && state.equals(pending.getString("state"))) slots.remove(PENDING);
  }
 }

 public Uri begin() throws Exception {
  JSONObject pending = beginPending("browser", PENDING_MS);
  return manageAccount().buildUpon().appendQueryParameter("device_challenge", challenge(pending))
      .appendQueryParameter("device_state", pending.getString("state")).build();
 }

 private JSONObject beginPending(String method, long duration) throws Exception {
  synchronized (LOCK) {
   if (credential() != null) throw new IllegalStateException("Sign out before adding another device account");
   JSONObject pending = new JSONObject().put("method", method).put("verifier", randomValue()).put("state", randomValue())
       .put("expiresAt", System.currentTimeMillis() + duration);
   slots.write(PENDING, pending.toString());
   return pending;
  }
 }

 URI passwordBackupOrigin() { return cloud; }
 Uri passwordBackupCallback() { return callback; }

 private static String challenge(JSONObject pending) throws Exception {
  byte[] verifier = pending.getString("verifier").getBytes(StandardCharsets.US_ASCII);
  return base64Url(MessageDigest.getInstance("SHA-256").digest(verifier));
 }

 public boolean handles(Uri data) { return matchesCallback(callback, data); }

 static boolean matchesCallback(Uri callback, Uri data) {
  return data != null && callback.getScheme().equals(data.getScheme()) && callback.getAuthority().equals(data.getEncodedAuthority())
      && callback.getPath().equals(data.getEncodedPath()) && data.getEncodedFragment() == null;
 }

 public boolean exchange(Uri data) throws Exception {
  if (!handles(data) || data.getQueryParameters("code").size() != 1 || data.getQueryParameters("state").size() != 1) return false;
  String code = data.getQueryParameter("code"), state = data.getQueryParameter("state");
  if (!opaque(code) || !opaque(state)) return false;
  String snapshot = pendingSnapshot(state, "browser");
  return snapshot != null && exchangeCode(code, snapshot);
 }

 private String pendingSnapshot(String state, String method) throws Exception {
  synchronized (LOCK) {
   String snapshot = slots.read(PENDING);
   if (snapshot == null) return null;
   JSONObject pending = new JSONObject(snapshot);
   return method.equals(pending.optString("method", "browser")) && state.equals(pending.getString("state"))
       && pendingActive(pending) ? snapshot : null;
  }
 }

 private static boolean pendingActive(JSONObject pending) throws JSONException {
  return pending.getLong("expiresAt") > System.currentTimeMillis();
 }

 private boolean exchangeCode(String code, String snapshot) throws Exception {
  JSONObject pending = new JSONObject(snapshot);
  String verifier = pending.getString("verifier");
  JSONObject request = new JSONObject().put("code", code).put("verifier", verifier);
  JSONObject response = new JSONObject(post("/api/auth/device/exchange", request, null, 200).body());
  String token = response.getString("token");
  long seconds = response.getLong("expiresIn");
  String accountId = identifier(response, "accountId"), organizationId = identifier(response, "organizationId");
  if (!opaque(token) || seconds < 1 || seconds > MAX_CREDENTIAL_SECONDS) throw new IOException("Invalid device credential response");
  JSONObject offered = response.optJSONObject("lease");
  long now = System.currentTimeMillis();
  JSONObject credential = new JSONObject().put("token", token).put("accountId", accountId).put("organizationId", organizationId)
      .put("issuedAt", now).put("expiresAt", now + seconds * 1000);
  if (offered != null) credential.put("lease", new JSONObject().put("refresh", leaseRefresh(offered, "refresh"))
      .put("refreshExpiresAt", now + leaseSeconds(offered, "refreshExpiresIn", MAX_LEASE_SECONDS) * 1000));
  synchronized (LOCK) {
   if (snapshot.equals(slots.read(PENDING)) && pendingActive(pending)) {
    slots.write(ACK, credential.toString());
    slots.remove(PENDING);
   } else {
    oweRevocation(duty(credential));
    return false;
   }
  }
  return finishAcknowledgment();
 }

 private static String leaseRefresh(JSONObject document, String key) throws Exception {
  String value = document.getString(key);
  if (!LEASE_REFRESH.matcher(value).matches()) throw new IOException("Invalid device lease");
  return value;
 }

 private static long leaseSeconds(JSONObject document, String key, long max) throws Exception {
  long seconds = document.getLong(key);
  if (seconds < 1 || seconds > max) throw new IOException("Invalid device lease lifetime");
  return seconds;
 }

 public boolean isDeviceOnly() throws Exception {
  synchronized (LOCK) {
   if (slots.read(CREDENTIAL) != null || slots.read(ACK) != null) return false;
   String pending = slots.read(PENDING);
   return pending == null || !pendingActive(new JSONObject(pending));
  }
 }

 public boolean awaitingAcknowledgment() throws Exception {
  synchronized (LOCK) { return slots.read(ACK) != null; }
 }

 public boolean finishAcknowledgment() throws Exception {
  final String pending;
  synchronized (LOCK) { pending = slots.read(ACK); }
  if (pending == null) return false;
  JSONObject credential = new JSONObject(pending);
  String token = credential.getString("token");
  if (!opaque(token)) throw new IOException("Invalid pending device credential");
  String credentialId = credential.optString("credentialId", "");
  boolean acknowledged = credentialId.isEmpty()
      ? post("/api/auth/device/ack", null, token, 204, 401, 410).status() == 204
      : post(ACKNOWLEDGE, new JSONObject().put("credentialId", credentialId).put("secret", token), null, 200, 400, 401, 410).status() == 200;
  synchronized (LOCK) {
   if (!pending.equals(slots.read(ACK))) return false;
   if (acknowledged) promote(credential);
   slots.remove(ACK);
   return acknowledged;
  }
 }

 private void promote(JSONObject acknowledged) throws Exception {
  String stored = slots.read(CREDENTIAL);
  JSONObject current = stored == null ? null : new JSONObject(stored);
  String replaces = acknowledged.optString("replaces", null);
  acknowledged.remove("replaces");
  if (replaces == null) {
   if (current != null) oweRevocation(duty(current));
   slots.write(CREDENTIAL, acknowledged.toString());
  } else if (current != null && replaces.equals(current.getString("token"))) {
   JSONObject replaced = new JSONObject().put("token", replaces).putOpt("credentialId", current.optString("credentialId", null));
   for (String key : List.of("token", "credentialId", "issuedAt", "expiresAt")) current.putOpt(key, acknowledged.opt(key));
   slots.write(CREDENTIAL, current.toString());
   oweRevocation(replaced);
  } else oweRevocation(duty(acknowledged));
 }

 public String credential() throws Exception {
  Session session = session();
  return session == null ? null : session.token();
 }

 public Session session() throws Exception {
  synchronized (LOCK) {
   String stored = slots.read(CREDENTIAL);
   if (stored == null) return null;
   JSONObject credential = new JSONObject(stored);
   String token = credential.getString("token");
   if (!opaque(token) || credential.getLong("expiresAt") <= System.currentTimeMillis()) return null;
   return new Session(token, identifier(credential, "accountId"), identifier(credential, "organizationId"));
  }
 }

 public void clear() throws Exception {
  synchronized (LOCK) {
   slots.remove(PENDING);
   for (String slot : List.of(ACK, CREDENTIAL)) {
    String stored = slots.read(slot);
    if (stored != null) oweRevocation(duty(new JSONObject(stored)));
    slots.remove(slot);
   }
  }
 }

 private static JSONObject duty(JSONObject credential) throws Exception {
  JSONObject duty = new JSONObject().put("token", credential.getString("token")).putOpt("credentialId", credential.optString("credentialId", null));
  JSONObject lease = credential.optJSONObject("lease");
  if (lease != null) duty.put("lease", newest(lease));
  return duty;
 }

 private void oweRevocation(JSONObject duty) throws Exception {
  JSONArray owed = duties();
  for (int index = 0; index < owed.length(); index++) if (sameDuty(owed.getJSONObject(index), duty)) return;
  owed.put(duty);
  while (owed.length() > MAX_DUTIES) owed.remove(0);
  slots.write(REVOKE, new JSONObject().put("duties", owed).toString());
 }

 private static boolean sameDuty(JSONObject left, JSONObject right) throws Exception {
  return left.getString("token").equals(right.getString("token"))
      && Objects.equals(left.optString("lease", null), right.optString("lease", null));
 }

 private JSONArray duties() throws Exception {
  String stored = slots.read(REVOKE);
  if (stored == null) return new JSONArray();
  JSONObject document = new JSONObject(stored);
  return document.has("duties") ? document.getJSONArray("duties") : new JSONArray().put(document);
 }

 public void retryRevocation() throws Exception {
  while (true) {
   final JSONObject duty;
   synchronized (LOCK) {
    JSONArray owed = duties();
    if (owed.length() == 0) return;
    duty = owed.getJSONObject(0);
   }
   String token = duty.getString("token"), lease = duty.optString("lease", null);
   if (!opaque(token) || (lease != null && !LEASE_REFRESH.matcher(lease).matches())) throw new IOException("Invalid stored device credential");
   if (canonical(duty)) {
    if (send("DELETE", SIGN_OUT, null, token, 204, 401).status() != 204 && lease != null) send("DELETE", LEASE_PATH, null, lease, 204, 401);
   } else if (lease == null || post("/api/auth/device/revoke", null, lease, 204, 401).status() != 204)
    post("/api/auth/device/revoke", null, token, 204, 401);
   synchronized (LOCK) {
    JSONArray owed = duties();
    for (int index = 0; index < owed.length(); index++) if (sameDuty(owed.getJSONObject(index), duty)) owed.remove(index--);
    if (owed.length() == 0) slots.remove(REVOKE);
    else slots.write(REVOKE, new JSONObject().put("duties", owed).toString());
   }
  }
 }

 private static boolean canonical(JSONObject credential) {
  return !credential.optString("credentialId", "").isEmpty();
 }

 private static String newest(JSONObject lease) throws Exception {
  return lease.has("offered") ? lease.getString("offered") : lease.getString("refresh");
 }

 private static long newestExpiry(JSONObject lease) throws Exception {
  return lease.has("offered") ? lease.getLong("offeredExpiresAt") : lease.getLong("refreshExpiresAt");
 }

 private JSONObject stored() throws Exception {
  synchronized (LOCK) {
   String stored = slots.read(CREDENTIAL);
   return stored == null ? null : new JSONObject(stored);
  }
 }

 public String leaseAccess() throws Exception {
  synchronized (LEASE) {
   JSONObject credential = stored();
   JSONObject lease = credential == null ? null : credential.optJSONObject("lease");
   if (lease == null) return null;
   String presented = newest(lease);
   if (access != null && access.mintedBy().equals(presented) && access.expiresAt() - ACCESS_MARGIN_MS > System.currentTimeMillis())
    return access.token();
   if (newestExpiry(lease) <= System.currentTimeMillis()) {
    clear();
    return null;
   }
   Exchange reply = post(canonical(credential) ? LEASE_PATH : "/api/auth/device/lease", null, presented, 200, 401);
   if (reply.status() == 401) {
    clear();
    return null;
   }
   JSONObject pair = new JSONObject(reply.body());
   String token = pair.getString("access"), next = leaseRefresh(pair, "refresh");
   if (!LEASE_ACCESS.matcher(token).matches()) throw new IOException("Invalid device lease");
   long now = System.currentTimeMillis();
   long accessExpiresAt = now + leaseSeconds(pair, "accessExpiresIn", MAX_ACCESS_SECONDS) * 1000;
   long nextExpiresAt = now + leaseSeconds(pair, "refreshExpiresIn", MAX_LEASE_SECONDS) * 1000;
   synchronized (LOCK) {
    JSONObject current = stored();
    JSONObject held = current == null ? null : current.optJSONObject("lease");
    if (held == null || !presented.equals(newest(held))) throw new IOException("Device account changed during a lease refresh");
    long presentedExpiresAt = newestExpiry(held);
    current.put("lease", new JSONObject().put("refresh", presented).put("refreshExpiresAt", presentedExpiresAt)
        .put("offered", next).put("offeredExpiresAt", nextExpiresAt));
    slots.write(CREDENTIAL, current.toString());
   }
   access = new Access(token, accessExpiresAt, next);
   return token;
  }
 }

 private void accessWorked(String token) throws Exception {
  synchronized (LEASE) {
   if (access == null || !access.token().equals(token)) return;
   synchronized (LOCK) {
    JSONObject current = stored();
    JSONObject held = current == null ? null : current.optJSONObject("lease");
    if (held == null || !access.mintedBy().equals(held.optString("offered", null))) return;
    current.put("lease", new JSONObject().put("refresh", held.getString("offered")).put("refreshExpiresAt", held.getLong("offeredExpiresAt")));
    slots.write(CREDENTIAL, current.toString());
   }
  }
 }

 private void accessRefused(String token) {
  synchronized (LEASE) {
   if (access != null && access.token().equals(token)) access = null;
  }
 }

 public MailResponse mailRequest(String method, String route, JSONObject query, JSONObject body, String idempotencyKey, String ifMatch) throws Exception {
  Pattern allowed = MAIL_ROUTES.get(method);
  if (allowed == null || route == null || !allowed.matcher(route).matches()) throw new IllegalArgumentException("Route is not a mail route");
  if (idempotencyKey != null && !idempotencyKey.matches("[A-Za-z0-9_-]{8,128}")) throw new IllegalArgumentException("Invalid idempotency key");
  if (ifMatch != null && !ifMatch.matches("[\\x21-\\x7e]{1,256}")) throw new IllegalArgumentException("Invalid entity tag");
  StringBuilder target = new StringBuilder(route);
  if (query != null) {
   char separator = '?';
   TreeSet<String> keys = new TreeSet<>();
   query.keys().forEachRemaining(keys::add);
   for (String key : keys) {
    Object value = query.get(key);
    if (!key.matches("[A-Za-z][A-Za-z0-9_]{0,63}") || !(value instanceof String || value instanceof Number || value instanceof Boolean))
     throw new IllegalArgumentException("Invalid mail query");
    target.append(separator).append(key).append('=').append(URLEncoder.encode(String.valueOf(value), "UTF-8").replace("+", "%20"));
    separator = '&';
   }
  }
  if (target.length() > 8192) throw new IllegalArgumentException("Mail query is too long");
  byte[] bytes = body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8);
  if (bytes != null && bytes.length > MAIL_REQUEST_BYTES) throw new IllegalArgumentException("Mail request is too large");
  Map<String, String> headers = new LinkedHashMap<>();
  if (idempotencyKey != null) headers.put("Idempotency-Key", idempotencyKey);
  if (ifMatch != null) headers.put("If-Match", ifMatch);
  Exchange answer = null;
  for (int attempt = 0; attempt < 2; attempt++) {
   String token = leaseAccess();
   if (token == null) {
    if (answer != null) break;
    throw new IllegalStateException("No mail lease is held");
   }
   answer = transfer(method, target.toString(), bytes, token, headers, MAIL_RESPONSE_BYTES);
   if (answer.status() != 401) {
    accessWorked(token);
    break;
   }
   accessRefused(token);
  }
  return new MailResponse(answer.status(), answer.body());
 }

 public boolean renewIfDue() throws Exception {
  if (awaitingAcknowledgment()) return finishAcknowledgment();
  synchronized (LEASE) {
   JSONObject credential = stored();
   JSONObject lease = credential == null ? null : credential.optJSONObject("lease");
   if (lease == null) return false;
   long now = System.currentTimeMillis(), expiresAt = credential.getLong("expiresAt");
   long issuedAt = credential.optLong("issuedAt", expiresAt - MAX_CREDENTIAL_SECONDS * 1000);
   if (now < issuedAt + (expiresAt - issuedAt) / 2) return false;
   if (newestExpiry(lease) <= now) {
    clear();
    return false;
   }
   boolean canonical = canonical(credential);
   Exchange reply = transfer("POST", canonical ? RENEW : "/api/auth/device/renew", null, newest(lease), Map.of(), 4096);
   if (reply.status() == 401) {
    clear();
    return false;
   }
   if (reply.status() != 200) return false;
   JSONObject renewed = new JSONObject(reply.body());
   String token = renewed.getString(canonical ? "secret" : "token");
   long seconds = renewed.getLong("expiresIn");
   if (!opaque(token) || seconds < 1 || seconds * 1000 > (canonical ? MAX_DEVICE_KEY_MS : MAX_CREDENTIAL_SECONDS * 1000)) throw new IOException("Invalid device credential response");
   synchronized (LOCK) {
    JSONObject current = stored();
    String replaces = credential.getString("token");
    JSONObject pending = new JSONObject().put("token", token).put("accountId", credential.getString("accountId"))
        .put("organizationId", credential.getString("organizationId")).put("issuedAt", now).put("expiresAt", now + seconds * 1000)
        .put("replaces", replaces);
    if (canonical) pending.put("credentialId", identifier(renewed, "credentialId"));
    if (current == null || !replaces.equals(current.getString("token"))) {
     oweRevocation(new JSONObject().put("token", token));
     return false;
    }
    slots.write(ACK, pending.toString());
   }
  }
  return finishAcknowledgment();
 }

 private record Exchange(int status, String body) {
  @Override public String toString() { return "CloudDeviceAccount.Exchange(" + status + ")"; }
 }

 private Exchange post(String path, JSONObject body, String bearer, int expected, int... retires) throws Exception {
  return send("POST", path, body, bearer, expected, retires);
 }

 private Exchange send(String method, String path, JSONObject body, String bearer, int expected, int... retires) throws Exception {
  Exchange answer = transfer(method, path, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), bearer, Map.of(), 4096);
  for (int retired : retires) if (answer.status() == retired) return answer;
  if (answer.status() != expected) throw new IOException("Device account request was refused");
  return answer;
 }

 private Exchange transfer(String method, String path, byte[] body, String bearer, Map<String, String> headers, int limit) throws IOException {
  HttpURLConnection connection = (HttpURLConnection) cloud.resolve(path).toURL().openConnection();
  connection.setInstanceFollowRedirects(false);
  connection.setUseCaches(false);
  connection.setConnectTimeout(8000);
  connection.setReadTimeout(10000);
  connection.setRequestMethod(method);
  connection.setRequestProperty("Accept", "application/json");
  if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
  headers.forEach(connection::setRequestProperty);
  try {
   if (body != null) {
    connection.setDoOutput(true);
    connection.setRequestProperty("Content-Type", "application/json");
    connection.setFixedLengthStreamingMode(body.length);
    try (var output = connection.getOutputStream()) { output.write(body); }
   }
   int status = connection.getResponseCode();
   InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
   if (stream == null) return new Exchange(status, "");
   try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
    byte[] chunk = new byte[8192];
    int count;
    while ((count = input.read(chunk)) != -1) {
     if (output.size() + count > limit) throw new IOException("Device account response is too large");
     output.write(chunk, 0, count);
    }
    return new Exchange(status, new String(output.toByteArray(), StandardCharsets.UTF_8));
   }
  } finally { connection.disconnect(); }
 }

 private static String identifier(JSONObject document, String key) throws Exception {
  String value = document.getString(key);
  if (!ID.matcher(value).matches()) throw new IOException("Invalid device account identity");
  return value;
 }

 private static boolean opaque(String value) { return value != null && OPAQUE.matcher(value).matches(); }
 private static String randomValue() {
  byte[] bytes = new byte[32];
  new SecureRandom().nextBytes(bytes);
  return base64Url(bytes);
 }
 private static String base64Url(byte[] bytes) {
  return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
 }
}
