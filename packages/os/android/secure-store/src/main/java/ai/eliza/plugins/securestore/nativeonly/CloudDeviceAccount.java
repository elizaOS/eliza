package ai.eliza.plugins.securestore.nativeonly;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.regex.Pattern;
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

 public Uri begin() throws Exception {
  synchronized (LOCK) {
   if (credential() != null) throw new IllegalStateException("Sign out before adding another device account");
   String verifier = randomValue(), state = randomValue();
   byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
   slots.write(PENDING, new JSONObject().put("verifier", verifier).put("state", state).put("expiresAt", System.currentTimeMillis() + PENDING_MS).toString());
   return manageAccount().buildUpon().appendQueryParameter("device_challenge", base64Url(digest)).appendQueryParameter("device_state", state).build();
  }
 }

 public boolean handles(Uri data) {
  return data != null && callback.getScheme().equals(data.getScheme()) && callback.getAuthority().equals(data.getEncodedAuthority())
      && callback.getPath().equals(data.getEncodedPath()) && data.getEncodedFragment() == null;
 }

 public boolean exchange(Uri data) throws Exception {
  if (!handles(data) || data.getQueryParameters("code").size() != 1 || data.getQueryParameters("state").size() != 1) return false;
  String code = data.getQueryParameter("code"), state = data.getQueryParameter("state");
  if (!opaque(code) || !opaque(state)) return false;
  String snapshot;
  synchronized (LOCK) {
   snapshot = slots.read(PENDING);
   if (snapshot == null) return false;
   JSONObject pending = new JSONObject(snapshot);
   if (!state.equals(pending.getString("state")) || pending.getLong("expiresAt") <= System.currentTimeMillis()) return false;
  }
  String verifier = new JSONObject(snapshot).getString("verifier");
  JSONObject request = new JSONObject().put("code", code).put("verifier", verifier);
  JSONObject response = new JSONObject(post("/api/auth/device/exchange", request, null, 200).body());
  String token = response.getString("token");
  long seconds = response.getLong("expiresIn");
  String accountId = identifier(response, "accountId"), organizationId = identifier(response, "organizationId");
  if (!opaque(token) || seconds < 1 || seconds > MAX_CREDENTIAL_SECONDS) throw new IOException("Invalid device credential response");
  synchronized (LOCK) {
   if (snapshot.equals(slots.read(PENDING))) {
    slots.write(ACK, new JSONObject().put("token", token).put("accountId", accountId).put("organizationId", organizationId).put("expiresAt", System.currentTimeMillis() + seconds * 1000).toString());
    slots.remove(PENDING);
   } else {
    slots.write(REVOKE, new JSONObject().put("token", token).toString());
    return false;
   }
  }
  return finishAcknowledgment();
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
  HttpURLConnection connection = (HttpURLConnection) cloud.resolve(path).toURL().openConnection();
  connection.setInstanceFollowRedirects(false);
  connection.setConnectTimeout(8000);
  connection.setReadTimeout(10000);
  connection.setRequestMethod("POST");
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
