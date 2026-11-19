package ai.eliza.plugins.securestore.nativeonly;

import android.accounts.Account;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.common.api.Scope;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
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

 public CloudDeviceAccount(Context host, String browserOrigin, String cloudOrigin, String callbackPath) {
  browser = Uri.parse(origin(browserOrigin).toString());
  cloud = origin(cloudOrigin);
  if (!callbackPath.matches("(?:/[a-z][a-z0-9-]*)+")) throw new IllegalArgumentException("Invalid callback path");
  callback = browser.buildUpon().path(callbackPath).build();
  slots = new JsonCredentialSlots(new File(host.getNoBackupFilesDir(), "eliza-cloud-device-account"), "eliza-cloud-device-account.v1", slot -> 1024);
 }

 private static URI origin(String input) {
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
  public AuthorizationRequest authorization(String googleAccount) {
   return googleAuthorization(serverClientId, googleAccount, scopes);
  }

  @Override public String toString() { return "CloudDeviceAccount.NativeGoogleAttempt"; }
 }

 public static AuthorizationRequest googleAuthorization(String serverClientId, String googleAccount, List<String> scopes) {
  if (googleAccount == null || !googleAccount.matches("[^@\\s]{1,64}@[^@\\s]{1,255}")) throw new IllegalArgumentException("Invalid Google account");
  List<Scope> requested = new ArrayList<>();
  for (String scope : scopes) requested.add(new Scope(scope));
  return AuthorizationRequest.builder().setRequestedScopes(requested).setAccount(new Account(googleAccount, "com.google"))
      .requestOfflineAccess(serverClientId, true).build();
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
  JSONArray listed = google.getJSONArray("scopes");
  for (int index = 0; index < listed.length(); index++) {
   String scope = listed.getString(index);
   if (!scope.matches("openid|email|https://www\\.googleapis\\.com/auth/[a-z.]{1,64}")) throw new IOException("Invalid Google scope");
   scopes.add(scope);
  }
  JSONObject pending = beginPending("google", 120_000L);
  String state = pending.getString("state");
  try {
   JSONObject response = new JSONObject(post("/api/v1/app-auth/mobile/google/challenge",
       client.put("challenge", challenge(pending)).put("state", state), null, 200).body());
   String challengeId = identifier(response, "challengeId"), nonce = response.getString("nonce");
   long seconds = response.getLong("expiresIn");
   if (!opaque(nonce) || seconds < 1 || seconds > 120)
    throw new IOException("Invalid Google challenge");
   long expiry = Math.min(pending.getLong("expiresAt"), System.currentTimeMillis() + seconds * 1000);
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
  JSONObject request = mobileClient(attempt.clientId(), attempt.environment())
      .put("challengeId", attempt.challengeId()).put("idToken", idToken);
  if (serverAuthCode != null) {
   if (!serverAuthCode.matches("[A-Za-z0-9/_.~-]{10,2048}")) throw new IOException("Invalid Google authorization");
   request.put("serverAuthCode", serverAuthCode);
  }
  JSONObject response = new JSONObject(post("/api/v1/app-auth/mobile/google", request, null, 200).body());
  String code = response.getString("code");
  return opaque(code) && attempt.state().equals(response.getString("state")) && exchangeCode(code, snapshot);
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

 URI passwordBackupEndpoint(String path) { return cloud.resolve(path); }
 Uri passwordBackupCallback() { return callback; }

 private static String challenge(JSONObject pending) throws Exception {
  byte[] verifier = pending.getString("verifier").getBytes(StandardCharsets.US_ASCII);
  return base64Url(MessageDigest.getInstance("SHA-256").digest(verifier));
 }

 public boolean handles(Uri data) {
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
  synchronized (LOCK) {
   if (snapshot.equals(slots.read(PENDING)) && pendingActive(pending)) {
    slots.write(ACK, new JSONObject().put("token", token).put("accountId", accountId).put("organizationId", organizationId).put("expiresAt", System.currentTimeMillis() + seconds * 1000).toString());
    slots.remove(PENDING);
   } else {
    slots.write(REVOKE, new JSONObject().put("token", token).toString());
    return false;
   }
  }
  return finishAcknowledgment();
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
  int status = post("/api/auth/device/ack", null, token, 204, 401, 410).status();
  synchronized (LOCK) {
   if (!pending.equals(slots.read(ACK))) return false;
   if (status == 204) slots.write(CREDENTIAL, pending);
   slots.remove(ACK);
   return status == 204;
  }
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
   String token = credential(), awaitingAck = slots.read(ACK);
   if (token == null && awaitingAck != null) token = new JSONObject(awaitingAck).getString("token");
   if (token != null && opaque(token)) slots.write(REVOKE, new JSONObject().put("token", token).toString());
   slots.remove(ACK);
   slots.remove(CREDENTIAL);
  }
 }

 public void retryRevocation() throws Exception {
  final String pending;
  synchronized (LOCK) { pending = slots.read(REVOKE); }
  if (pending == null) return;
  String token = new JSONObject(pending).getString("token");
  if (!opaque(token)) throw new IOException("Invalid stored device credential");
  post("/api/auth/device/revoke", null, token, 204);
  synchronized (LOCK) {
   if (pending.equals(slots.read(REVOKE))) slots.remove(REVOKE);
  }
 }

 private record Exchange(int status, String body) {
  @Override public String toString() { return "CloudDeviceAccount.Exchange(" + status + ")"; }
 }

 private Exchange post(String path, JSONObject body, String bearer, int expected, int... retires) throws Exception {
  return send("POST", path, body, bearer, expected, retires);
 }

 private Exchange send(String method, String path, JSONObject body, String bearer, int expected, int... retires) throws Exception {
  HttpURLConnection connection = (HttpURLConnection) cloud.resolve(path).toURL().openConnection();
  connection.setInstanceFollowRedirects(false);
  connection.setConnectTimeout(8000);
  connection.setReadTimeout(10000);
  connection.setRequestMethod(method);
  connection.setRequestProperty("Accept", "application/json");
  if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
  try {
   if (body != null) {
    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
    connection.setDoOutput(true);
    connection.setRequestProperty("Content-Type", "application/json");
    connection.setFixedLengthStreamingMode(bytes.length);
    try (var output = connection.getOutputStream()) { output.write(bytes); }
   }
   int status = connection.getResponseCode();
   for (int retired : retires) if (status == retired) return new Exchange(status, "");
   if (status != expected) throw new IOException("Device account request was refused");
   if (status == 204) return new Exchange(status, "");
   try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
    byte[] chunk = new byte[512];
    int count;
    while ((count = input.read(chunk)) != -1) {
     if (output.size() + count > 4096) throw new IOException("Device account response is too large");
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
  return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
 }
}
