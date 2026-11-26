// spec/os/signIn/flow.md, "Standalone email sign-in exchanges a session only after an accepted code and retires an attempt that needs an additional factor"
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
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
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
 private static final long EMAIL_CODE_MS = 10 * 60_000L;
 private static final long NATIVE_GOOGLE_PENDING_MS = 2 * 60_000L;
 private static final long NATIVE_GOOGLE_CHALLENGE_MS = 5 * 60_000L;
 private static final long MAX_CREDENTIAL_SECONDS = 7 * 24 * 60 * 60L;
 private static final long MAX_DEVICE_KEY_MS = 90 * 24 * 60 * 60_000L;
 private static final String CHALLENGE = "/api/v1/auth/google/native/challenge";
 private static final String SIGN_IN = "/api/v1/app-auth/mobile/google";
 private static final String EMAIL_START = "/api/v1/auth/email/code/send";
 private static final String EMAIL_VERIFY = "/api/v1/auth/email/code/verify";
 private static final String SESSION_LOGOUT = "/api/v1/auth/logout";
 private static final String DEVICE_CONNECT = "/api/v1/app-auth/connect";
 private static final String DEVICE_TOKEN = "/api/v1/app-auth/mobile/token";
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
 public record MailAuthority(String accountId, String organizationId, String epoch) {}
 public enum LeaseUpgradeStatus { NOT_REQUIRED, REQUIRED, SIGN_IN_PENDING, ACKNOWLEDGMENT_PENDING }
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

 private JSONObject mobileConfiguration(JSONObject client) throws Exception {
  String query = new Uri.Builder().appendQueryParameter("clientId", client.getString("clientId"))
      .appendQueryParameter("environment", client.getString("environment"))
      .appendQueryParameter("redirectUri", client.getString("redirectUri")).build().getEncodedQuery();
  return new JSONObject(send("GET", "/api/v1/app-auth/mobile/config?" + query, null, null, 200).body());
 }

 public boolean leaseUpgradeAvailable(String clientId, String environment) {
  try { return offersMailLease(mobileClient(clientId, environment)); }
  catch (Exception unavailable) { return false; }
 }

 private boolean offersMailLease(JSONObject client) throws Exception {
  JSONObject config = mobileConfiguration(client);
  return Boolean.TRUE.equals(config.opt("mailLease")) && sameRegistration(client, config);
 }

 private static boolean sameRegistration(JSONObject left, JSONObject right) {
  return left.optString("clientId").equals(right.optString("clientId"))
      && left.optString("environment").equals(right.optString("environment"))
      && left.optString("redirectUri").equals(right.optString("redirectUri"));
 }

 public enum EmailSignIn { SIGNED_IN, ADDITIONAL_VERIFICATION, REFUSED }

 public void sendEmailSignInCode(String clientId, String environment, String destination) throws Exception {
  String email = emailAddress(destination);
  JSONObject client = mobileClient(clientId, environment);
  JSONObject config = mobileConfiguration(client);
  var methods = config.optJSONObject("methods");
  if (!sameRegistration(client, config) || methods == null || !Boolean.TRUE.equals(methods.opt("email")))
   throw new IOException("Email sign-in is unavailable");
  JSONObject pending;
  synchronized (LOCK) {
   if (credential() != null || slots.read(ACK) != null) throw new IOException("The device account changed");
   pending = newPending("email", EMAIL_CODE_MS).put("email", email).put("client", client);
   slots.write(PENDING, pending.toString());
  }
  String state = pending.getString("state");
  try {
   var request = new JSONObject().put("email", email).put("clientId", clientId)
     .put("codeChallenge", challenge(pending)).put("codeChallengeMethod", "S256");
   var sent = new JSONObject(post(EMAIL_START, request, null, 200, 202).body());
   long expires = sent.getLong("expiresAt");
   synchronized (LOCK) {
    if (sent.getInt("codeLength") != 6 || expires <= System.currentTimeMillis()
        || !pending.toString().equals(pendingSnapshot(state, "email"))) throw new IOException("Email sign-in was not started");
    pending.put("expiresAt", Math.min(pending.getLong("expiresAt"), expires));
    slots.write(PENDING, pending.toString());
   }
  } catch (Exception unavailable) {
   clearPending("email", state);
   throw unavailable;
  }
 }

 public EmailSignIn verifyEmailSignInCode(String destination, String code) throws Exception {
  String email = emailAddress(destination);
  if (code == null || !code.matches("[0-9]{6}")) return EmailSignIn.REFUSED;
  String snapshot = slots.read(PENDING);
  var pending = snapshot == null ? null : new JSONObject(snapshot);
  if (pending == null || !"email".equals(pending.optString("method")) || !email.equals(pending.optString("email")) || !pendingActive(pending))
   return EmailSignIn.REFUSED;
  var client = pending.getJSONObject("client");
  String state = pending.getString("state"), verifier = pending.getString("verifier");
  var proof = new JSONObject().put("email", email).put("code", code).put("clientId", client.getString("clientId"))
    .put("codeVerifier", verifier);
  var result = new JSONObject(post(EMAIL_VERIFY, proof, null, 200).body());
  if ("mfa_required".equals(result.optString("status"))) {
   clearPending("email", state);
   return EmailSignIn.ADDITIONAL_VERIFICATION;
  }
  if (!"signed_in".equals(result.optString("status"))) return EmailSignIn.REFUSED;
  String session = result.getString("accessToken"), refresh = result.getString("refreshToken");
  if (!session.matches("eliza_session_[A-Za-z0-9_-]{43}") || !refresh.matches("eliza_refresh_[A-Za-z0-9_-]{54}"))
   throw new IOException("Invalid sign-in session");
  try {
   if (!snapshot.equals(pendingSnapshot(state, "email")) || result.getLong("accessExpiresAt") <= System.currentTimeMillis())
    return EmailSignIn.REFUSED;
   String exchangeVerifier = randomValue();
   var connect = new JSONObject(client.toString()).put("state", state).put("codeChallenge", digest(exchangeVerifier))
     .put("codeChallengeMethod", "S256").put("flow", "mobile_pkce");
   var enrollment = new JSONObject(post(DEVICE_CONNECT, connect, session, 200).body());
   String grant = enrollment.getString("code");
   if (!grant.matches("emac_[a-f0-9]{64}") || !snapshot.equals(pendingSnapshot(state, "email"))) return EmailSignIn.REFUSED;
   var request = new JSONObject(client.toString()).put("grantType", "authorization_code").put("code", grant)
     .put("state", state).put("codeVerifier", exchangeVerifier);
   var key = new JSONObject(post(DEVICE_TOKEN, request, null, 200).body());
   if (!identifier(result.getJSONObject("user"), "id").equals(identifier(key.getJSONObject("user"), "id"))
       || !identifier(result, "organizationId").equals(identifier(key, "organizationId"))) {
    synchronized (LOCK) { oweRevocation(duty(deviceKey(key))); }
    return EmailSignIn.REFUSED;
   }
   return keepDeviceKey(key, snapshot) ? EmailSignIn.SIGNED_IN : EmailSignIn.REFUSED;
  } finally {
   try { post(SESSION_LOGOUT, new JSONObject().put("refreshToken", refresh), null, 204, 401); }
   catch (Exception unavailable) { }
   clearPending("email", state);
  }
 }

 public void cancelEmailSignInCode() throws Exception { clearPending("email", null); }

 private static String emailAddress(String value) throws IOException {
  String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
  if (normalized.length() > 254 || !normalized.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) throw new IOException("Invalid sign-in address");
  return normalized;
 }

 public NativeGoogleAttempt prepareNativeGoogle(String clientId, String environment) throws Exception {
  return prepareNativeGoogle(clientId, environment, null);
 }

 public NativeGoogleAttempt prepareNativeGoogleLeaseUpgrade(String clientId, String environment) throws Exception {
  JSONObject upgrade = mobileClient(clientId, environment);
  synchronized (LOCK) {
   if (leaseUpgradeStatus() != LeaseUpgradeStatus.REQUIRED || slots.read(ACK) != null)
    throw new IllegalStateException("An existing device account without a mail lease is required");
   upgrade.put("credential", digest(stored().getString("token")));
  }
  return prepareNativeGoogle(clientId, environment, upgrade);
 }

 private NativeGoogleAttempt prepareNativeGoogle(String clientId, String environment, JSONObject upgrade) throws Exception {
  JSONObject client = mobileClient(clientId, environment);
  JSONObject config = mobileConfiguration(client);
  if (upgrade != null && (!Boolean.TRUE.equals(config.opt("mailLease")) || !sameRegistration(client, config))) return null;
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
  JSONObject pending = beginPending("google", NATIVE_GOOGLE_PENDING_MS, upgrade);
  String state = pending.getString("state");
  try {
   JSONObject response = new JSONObject(post(CHALLENGE,
       client.put("codeChallenge", challenge(pending)).put("codeChallengeMethod", "S256"), null, 200).body());
   String challengeId = identifier(response, "challengeId"), nonce = response.getString("nonce");
   long due = response.getLong("expiresAt"), now = System.currentTimeMillis();
   if (!opaque(nonce) || due <= now || due > now + NATIVE_GOOGLE_CHALLENGE_MS || !serverClientId.equals(response.getString("serverClientId")))
    throw new IOException("Invalid Google challenge");
   long expiry = Math.min(pending.getLong("expiresAt"), due);
   return new NativeGoogleAttempt(clientId, environment, serverClientId, Collections.unmodifiableList(scopes), challengeId, nonce, state, expiry);
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
  JSONObject pending = new JSONObject(snapshot);
  JSONObject upgrade = pending.optJSONObject("upgrade");
  if (upgrade != null && (!offersMailLease(upgrade) || !snapshot.equals(pendingSnapshot(attempt.state(), "google")))) {
   clearNativeGoogle(attempt.state());
   return false;
  }
  String verifier = pending.getString("verifier");
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
  return stageCredential(deviceKey(response), snapshot);
 }

 private static JSONObject deviceKey(JSONObject response) throws Exception {
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
  return key;
 }

 public void cancelNativeGoogle(NativeGoogleAttempt attempt) throws Exception {
  clearNativeGoogle(attempt.state());
 }

 private void clearNativeGoogle(String state) throws Exception {
  clearPending("google", state);
 }

 private void clearPending(String method, String state) throws Exception {
  synchronized (LOCK) {
   String saved = slots.read(PENDING);
   if (saved == null) return;
   JSONObject pending = new JSONObject(saved);
   if (method.equals(pending.optString("method")) && (state == null || state.equals(pending.getString("state")))) slots.remove(PENDING);
  }
 }

 public Uri begin() throws Exception {
  return browserStart(beginPending("browser", PENDING_MS));
 }

 // spec/os/signIn/browserReturn.md, "Story: Reconnect a signed-in device for mail and calendar"
 public LeaseUpgradeStatus leaseUpgradeStatus() throws Exception {
  synchronized (LOCK) {
   JSONObject current = stored();
   if (current == null || current.optJSONObject("lease") != null) return LeaseUpgradeStatus.NOT_REQUIRED;
   JSONObject acknowledgment = record(ACK);
   if (acknowledgment != null && holdsToken(current, acknowledgment.optJSONObject("upgradeFrom"))) {
    return LeaseUpgradeStatus.ACKNOWLEDGMENT_PENDING;
   }
   JSONObject pending = record(PENDING);
   if (pending != null && pendingActive(pending) && matchesUpgrade(current, pending.optJSONObject("upgrade"))) {
    return LeaseUpgradeStatus.SIGN_IN_PENDING;
   }
   return sessionOf(current) == null ? LeaseUpgradeStatus.NOT_REQUIRED : LeaseUpgradeStatus.REQUIRED;
  }
 }

 public Uri beginLeaseUpgrade(String clientId, String environment) throws Exception {
  JSONObject upgrade = mobileClient(clientId, environment);
  synchronized (LOCK) {
   LeaseUpgradeStatus status = leaseUpgradeStatus();
   if (status == LeaseUpgradeStatus.SIGN_IN_PENDING) return existingLeaseUpgrade(upgrade);
   if (status != LeaseUpgradeStatus.REQUIRED || slots.read(ACK) != null) {
    throw new IllegalStateException("An existing device account without a mail lease is required");
   }
   upgrade.put("credential", digest(stored().getString("token")));
  }
  if (!offersMailLease(upgrade)) throw new IllegalStateException("The host does not offer mail leases");
  synchronized (LOCK) {
   LeaseUpgradeStatus status = leaseUpgradeStatus();
   if (!matchesUpgrade(stored(), upgrade) || slots.read(ACK) != null)
    throw new IllegalStateException("The device account changed");
   if (status == LeaseUpgradeStatus.SIGN_IN_PENDING) return existingLeaseUpgrade(upgrade);
   if (status != LeaseUpgradeStatus.REQUIRED) throw new IllegalStateException("The device account changed");
   JSONObject pending = newPending("browser", PENDING_MS).put("upgrade", upgrade);
   slots.write(PENDING, pending.toString());
   return browserStart(pending);
  }
 }

 private Uri existingLeaseUpgrade(JSONObject registration) throws Exception {
  JSONObject pending = record(PENDING);
  if (!sameRegistration(registration, pending.getJSONObject("upgrade"))) throw new IllegalStateException("The enrollment registration changed");
  return browserStart(pending);
 }

 public void cancelLeaseUpgrade(Uri start) throws Exception {
  synchronized (LOCK) {
   JSONObject pending = record(PENDING);
   if (pending != null && pending.optJSONObject("upgrade") != null && start != null
       && pending.getString("state").equals(start.getQueryParameter("device_state"))) slots.remove(PENDING);
  }
 }

 public void cancelLeaseUpgrade() throws Exception {
  synchronized (LOCK) {
   JSONObject pending = record(PENDING);
   if (pending != null && pending.optJSONObject("upgrade") != null) slots.remove(PENDING);
  }
 }

 private Uri browserStart(JSONObject pending) throws Exception {
  return manageAccount().buildUpon().appendQueryParameter("device_challenge", challenge(pending))
      .appendQueryParameter("device_state", pending.getString("state")).build();
 }

 private JSONObject beginPending(String method, long duration) throws Exception {
  return beginPending(method, duration, null);
 }

 private JSONObject beginPending(String method, long duration, JSONObject upgrade) throws Exception {
  synchronized (LOCK) {
   JSONObject pending = newPending(method, duration);
   if (upgrade == null) {
    if (credential() != null) throw new IllegalStateException("Sign out before adding another device account");
   } else {
    JSONObject current = stored();
    if (!matchesUpgrade(current, upgrade) || leaseUpgradeStatus() != LeaseUpgradeStatus.REQUIRED || slots.read(ACK) != null)
     throw new IllegalStateException("The device account changed");
    pending.put("upgrade", upgrade);
   }
   slots.write(PENDING, pending.toString());
   return pending;
  }
 }

 private static JSONObject newPending(String method, long duration) throws JSONException {
  return new JSONObject().put("method", method).put("verifier", randomValue()).put("state", randomValue())
      .put("expiresAt", System.currentTimeMillis() + duration);
 }

 URI passwordBackupOrigin() { return cloud; }
 Uri passwordBackupCallback() { return callback; }

 private static String challenge(JSONObject pending) throws Exception {
  return digest(pending.getString("verifier"));
 }

 private static String digest(String proof) throws Exception {
  return base64Url(MessageDigest.getInstance("SHA-256").digest(proof.getBytes(StandardCharsets.US_ASCII)));
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
  JSONObject upgrade = pending.optJSONObject("upgrade");
  if (upgrade != null && (!callback.toString().equals(upgrade.optString("redirectUri"))
      || !leaseUpgradeAvailable(upgrade.optString("clientId"), upgrade.optString("environment")))) {
   synchronized (LOCK) {
    if (snapshot.equals(slots.read(PENDING))) slots.remove(PENDING);
   }
   return false;
  }
  if (upgrade != null && !snapshot.equals(pendingSnapshot(pending.getString("state"), "browser"))) return false;
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
  return stageCredential(credential, snapshot);
 }

 private boolean stageCredential(JSONObject credential, String snapshot) throws Exception {
  JSONObject pending = new JSONObject(snapshot);
  synchronized (LOCK) {
   if (!snapshot.equals(slots.read(PENDING)) || !pendingActive(pending)) {
    oweRevocation(duty(credential));
    return false;
   }
   JSONObject upgrade = pending.optJSONObject("upgrade");
   if (upgrade != null) {
    JSONObject current = stored();
    if (!matchesUpgrade(current, upgrade) || credential.optJSONObject("lease") == null
        || !sameOwner(current, credential) || holdsToken(current, credential)) {
     if (!holdsToken(current, credential)) oweRevocation(duty(credential));
     slots.remove(PENDING);
     return false;
    }
    credential.put("upgradeFrom", duty(current));
   }
   slots.write(ACK, credential.toString());
   slots.remove(PENDING);
  }
  return finishAcknowledgment();
 }

 private static boolean matchesUpgrade(JSONObject current, JSONObject upgrade) throws Exception {
  return current != null && upgrade != null && current.optJSONObject("lease") == null
      && upgrade.getString("credential").equals(digest(current.getString("token")));
 }

 private static boolean sameOwner(JSONObject current, JSONObject offered) throws JSONException {
  return current.getString("accountId").equals(offered.getString("accountId"))
      && current.getString("organizationId").equals(offered.getString("organizationId"));
 }

 private static boolean holdsToken(JSONObject current, JSONObject other) throws JSONException {
  return current != null && other != null && current.getString("token").equals(other.getString("token"));
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
  final JSONObject credential;
  final JSONObject upgradeFrom;
  synchronized (LOCK) {
   pending = slots.read(ACK);
   if (pending == null) return false;
   credential = new JSONObject(pending);
   upgradeFrom = credential.optJSONObject("upgradeFrom");
   if (upgradeFrom != null && holdsToken(stored(), credential)) {
    oweRevocation(upgradeFrom);
    slots.remove(ACK);
    return true;
   }
  }
  String token = credential.getString("token");
  if (!opaque(token)) throw new IOException("Invalid pending device credential");
  String credentialId = credential.optString("credentialId", "");
  boolean acknowledged = credentialId.isEmpty()
      ? post("/api/auth/device/ack", null, token, 204, 401, 410).status() == 204
      : post(ACKNOWLEDGE, new JSONObject().put("credentialId", credentialId).put("secret", token), null, 200, 400, 401, 410).status() == 200;
  synchronized (LOCK) {
   if (!pending.equals(slots.read(ACK))) {
    if (acknowledged && upgradeFrom != null && !holdsToken(stored(), credential)) oweRevocation(duty(credential));
    return false;
   }
   if (acknowledged) {
    if (upgradeFrom == null) promote(credential);
    else acknowledged = promoteUpgrade(credential, upgradeFrom);
   }
   slots.remove(ACK);
   return acknowledged;
  }
 }

 private boolean promoteUpgrade(JSONObject credential, JSONObject upgradeFrom) throws Exception {
  JSONObject current = stored();
  if (!holdsToken(current, upgradeFrom) || !sameOwner(current, credential)) {
   oweRevocation(duty(credential));
   return false;
  }
  credential.remove("upgradeFrom");
  slots.write(CREDENTIAL, credential.toString());
  oweRevocation(upgradeFrom);
  return true;
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
   current.put("binding", bindingOf(current));
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
  return sessionOf(stored());
 }

 private static String bindingOf(JSONObject credential) throws Exception {
  if (credential.has("binding")) return credential.getString("binding");
  return base64Url(MessageDigest.getInstance("SHA-256").digest(credential.getString("token").getBytes(StandardCharsets.UTF_8)));
 }

 public String accountBinding(String currentSecret) throws Exception {
  synchronized (LOCK) {
   JSONObject credential = stored();
   Session current = sessionOf(credential);
   return current != null && current.token().equals(currentSecret) ? bindingOf(credential) : null;
  }
 }

 public MailAuthority mailAuthority() throws Exception {
  JSONObject credential = stored();
  JSONObject lease = credential == null ? null : credential.optJSONObject("lease");
  if (lease == null || newestExpiry(lease) <= System.currentTimeMillis()) return null;
  String credentialId = credential.optString("credentialId", "");
  String epoch = credentialId.isEmpty() ? digest(credential.getString("token")) : credentialId;
  return new MailAuthority(identifier(credential, "accountId"), identifier(credential, "organizationId"), epoch);
 }

 private static Session sessionOf(JSONObject credential) throws Exception {
  if (credential == null) return null;
  String token = credential.getString("token");
  if (!opaque(token) || credential.getLong("expiresAt") <= System.currentTimeMillis()) return null;
  return new Session(token, identifier(credential, "accountId"), identifier(credential, "organizationId"));
 }

 public void clear() throws Exception {
  synchronized (LOCK) {
   slots.remove(PENDING);
   for (String slot : List.of(ACK, CREDENTIAL)) {
    JSONObject held = record(slot);
    if (held != null) {
     oweRevocation(duty(held));
     JSONObject upgradeFrom = held.optJSONObject("upgradeFrom");
     if (upgradeFrom != null) oweRevocation(upgradeFrom);
    }
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

 private void retireLease(JSONObject expected, String refresh) throws Exception {
  synchronized (LOCK) {
   JSONObject current = stored();
   JSONObject lease = current == null ? null : current.optJSONObject("lease");
   if (lease != null && holdsToken(current, expected) && refresh.equals(newest(lease))) clear();
  }
 }

 private JSONObject stored() throws Exception {
  synchronized (LOCK) { return record(CREDENTIAL); }
 }

 private JSONObject record(String slot) throws Exception {
  String stored = slots.read(slot);
  return stored == null ? null : new JSONObject(stored);
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
    retireLease(credential, presented);
    return null;
   }
   Exchange reply = post(canonical(credential) ? LEASE_PATH : "/api/auth/device/lease", null, presented, 200, 401);
   if (reply.status() == 401) {
    retireLease(credential, presented);
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
    if (held == null || !holdsToken(current, credential) || !presented.equals(newest(held)))
     throw new IOException("Device account changed during a lease refresh");
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
  return mailRequest(method, route, query, body, idempotencyKey, ifMatch, null);
 }

 public MailResponse readMail(MailAuthority expected, String route, JSONObject query) throws Exception {
  if (expected == null) throw new IllegalStateException("No mail lease is held");
  return mailRequest("GET", route, query, null, null, null, expected);
 }

 private void requireMailAuthority(MailAuthority expected) throws Exception {
  if (expected != null && !expected.equals(mailAuthority())) throw new IllegalStateException("Mail account changed");
 }

 private MailResponse mailRequest(String method, String route, JSONObject query, JSONObject body, String idempotencyKey, String ifMatch, MailAuthority expected) throws Exception {
  Pattern allowed = MAIL_ROUTES.get(method);
  List<String> scopedKeys = expected == null ? null : MailReadRoutes.queriesFor(route);
  if (allowed == null || route == null || !allowed.matcher(route).matches() || expected != null && scopedKeys == null)
   throw new IllegalArgumentException("Route is not a mail route");
  if (idempotencyKey != null && !idempotencyKey.matches("[A-Za-z0-9_-]{8,128}")) throw new IllegalArgumentException("Invalid idempotency key");
  if (ifMatch != null && !ifMatch.matches("[\\x21-\\x7e]{1,256}")) throw new IllegalArgumentException("Invalid entity tag");
  StringBuilder target = new StringBuilder(route);
  if (query != null) {
   char separator = '?';
   TreeSet<String> keys = new TreeSet<>();
   query.keys().forEachRemaining(keys::add);
   for (String key : keys) {
    Object value = query.get(key);
    if (!key.matches("[A-Za-z][A-Za-z0-9_]{0,63}") || scopedKeys != null && !scopedKeys.contains(key)
        || !(value instanceof String || value instanceof Number || value instanceof Boolean))
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
   requireMailAuthority(expected);
   String token = leaseAccess();
   if (token == null) {
    if (answer != null) break;
    throw new IllegalStateException("No mail lease is held");
   }
   requireMailAuthority(expected);
   answer = transfer(method, target.toString(), bytes, token, headers, MAIL_RESPONSE_BYTES);
   requireMailAuthority(expected);
   if (answer.status() != 401) {
    accessWorked(token);
    break;
   }
   accessRefused(token);
  }
  return new MailResponse(answer.status(), answer.body());
 }

 public void maintainLease() throws Exception {
  JSONObject credential = stored();
  JSONObject lease = credential == null ? null : credential.optJSONObject("lease");
  if (lease != null && newestExpiry(lease) - System.currentTimeMillis() <= 7L * 24 * 60 * 60_000) leaseAccess();
  renewIfDue();
  retryRevocation();
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
   String presented = newest(lease);
   if (newestExpiry(lease) <= now) {
    retireLease(credential, presented);
    return false;
   }
   boolean canonical = canonical(credential);
   Exchange reply = post(canonical ? RENEW : "/api/auth/device/renew", null, presented, 200, 401);
   if (reply.status() == 401) {
    retireLease(credential, presented);
    return false;
   }
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
    if (!holdsToken(current, credential)) {
     oweRevocation(duty(pending));
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
