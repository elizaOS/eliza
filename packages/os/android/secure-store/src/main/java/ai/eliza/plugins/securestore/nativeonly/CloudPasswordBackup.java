package ai.eliza.plugins.securestore.nativeonly;

import android.net.Uri;
import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

public final class CloudPasswordBackup {
  private static final String PATH = "/api/v1/app-auth/mobile/password-backup";
  private static final int MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
  private static final int TIMEOUT_MS = 10_000;

  public enum Purpose {
    READ("read", "GET"), SAVE("save", "PUT"), DELETE("delete", "DELETE"), VERIFY("verify", null);
    private final String value;
    private final String method;
    Purpose(String value, String method) { this.value = value; this.method = method; }
  }

  public record Response(int status, String revision, byte[] ciphertext) {}

  public static final class Approval {
    private final URI endpoint;
    private final Purpose purpose;
    private final String code;
    private final String state;
    private final String verifier;
    private final String scope;
    private final String ownerId;
    private final String revision;
    private final boolean present;
    private final BooleanSupplier current;
    private boolean spent;

    private Approval(URI endpoint, Purpose purpose, String code, String state, String verifier, String scope, String ownerId, String revision, boolean present, BooleanSupplier current) {
      this.endpoint = endpoint;
      this.purpose = purpose;
      this.code = code;
      this.state = state;
      this.verifier = verifier;
      this.scope = scope;
      this.ownerId = ownerId;
      this.revision = revision;
      this.present = present;
      this.current = current;
    }

    public String scope() { return scope; }
    public String ownerId() { return ownerId; }
    public String revision() { return revision; }
    public boolean present() { return present; }
    public boolean current() { return current.getAsBoolean(); }

    public synchronized Response run(String expectedRevision, byte[] ciphertext) throws IOException {
      if (spent || purpose == Purpose.VERIFY || !current.getAsBoolean() || (expectedRevision != null && !expectedRevision.matches("\"[1-9][0-9]{0,9}\""))
          || (purpose == Purpose.DELETE && expectedRevision == null)
          || (purpose == Purpose.READ && expectedRevision != null)
          || (purpose == Purpose.SAVE && (ciphertext == null || ciphertext.length == 0 || ciphertext.length > MAX_SNAPSHOT_BYTES))
          || (purpose != Purpose.SAVE && ciphertext != null)) {
        throw new IOException("Invalid password backup request");
      }
      spent = true;
      HttpsURLConnection request = connect(endpoint, purpose.method, code);
      try {
        request.setRequestProperty("X-Backup-Verifier", verifier);
        request.setRequestProperty("X-Backup-State", state);
        if (expectedRevision != null) request.setRequestProperty("If-Match", expectedRevision);
        if (purpose == Purpose.SAVE) {
          if (expectedRevision == null) request.setRequestProperty("If-None-Match", "*");
          send(request, "application/octet-stream", ciphertext);
        }
        int status = request.getResponseCode();
        if (!current.getAsBoolean()) throw new IOException("Password backup closed");
        if (status >= 300 && status < 400) throw new IOException("Unexpected password backup redirect");
        String revision = request.getHeaderField("ETag");
        if (revision != null && !revision.matches("\"[1-9][0-9]{0,9}\"")) {
          throw new IOException("Invalid password backup revision");
        }
        if (purpose == Purpose.READ && status == 200) {
          if (revision == null || !"application/octet-stream".equals(request.getContentType())) {
            throw new IOException("Invalid password backup response");
          }
          return new Response(status, revision, body(request, MAX_SNAPSHOT_BYTES));
        }
        if (status == 204 && revision == null) throw new IOException("Missing password backup revision");
        return new Response(status, revision, null);
      } finally {
        request.disconnect();
      }
    }
  }

  private static final String CODE = "pbackup_[A-Za-z0-9_-]{43}";
  private static final long APPROVAL_MILLIS = 5 * 60_000L;
  private final CloudDeviceAccount accounts;
  private final String clientId;
  private final String environment;
  private Pending pending;

  private record Pending(CloudDeviceAccount.Session account, Purpose purpose, String verifier, String state, long expires) {}

  public CloudPasswordBackup(CloudDeviceAccount accounts, String clientId, String environment) {
    if (!clientId.matches("[a-z][a-z0-9.-]{0,127}") || !environment.matches("[a-z][a-z0-9-]{0,63}")) {
      throw new IllegalArgumentException("Invalid password backup profile");
    }
    this.accounts = accounts;
    this.clientId = clientId;
    this.environment = environment;
  }

  public static boolean isBackupReturn(Uri data) {
    if (data == null) return false;
    return data.getQueryParameters("code").stream().anyMatch(code -> code.startsWith("pbackup_"));
  }

  public synchronized Uri begin(Purpose purpose) throws Exception {
    CloudDeviceAccount.Session account = accounts.session();
    if (account == null) throw new IOException("Sign in on this device first");
    String verifier = randomValue(), state = randomValue();
    String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
      MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    pending = new Pending(account, purpose, verifier, state, SystemClock.elapsedRealtime() + APPROVAL_MILLIS);
    return Uri.parse(accounts.passwordBackupEndpoint(PATH + "/approve").toString()).buildUpon()
      .appendQueryParameter("clientId", clientId).appendQueryParameter("environment", environment)
      .appendQueryParameter("redirectUri", accounts.passwordBackupCallback().toString())
      .appendQueryParameter("state", state).appendQueryParameter("codeChallenge", challenge)
      .appendQueryParameter("codeChallengeMethod", "S256").appendQueryParameter("purpose", purpose.value).build();
  }

  public synchronized void cancel() { pending = null; }

  public boolean available() {
    try {
      if (accounts.session() == null) return false;
      URI endpoint = URI.create(accounts.passwordBackupEndpoint(PATH + "/readiness") + "?clientId=" + clientId +
        "&environment=" + environment);
      HttpsURLConnection request = connect(endpoint, "GET", null);
      try { return request.getResponseCode() == 204; }
      finally { request.disconnect(); }
    } catch (Exception unavailable) {
      return false;
    }
  }

  public synchronized boolean accepts(Uri callback) {
    if (!accounts.handles(callback) || callback.getQueryParameters("code").size() != 1
        || callback.getQueryParameters("state").size() != 1
        || !callback.getQueryParameter("code").matches(CODE)) return false;
    return pending != null && pending.state.equals(callback.getQueryParameter("state"));
  }

  private synchronized Pending redeem(Uri callback) {
    if (!accepts(callback)) return null;
    Pending attempt = pending;
    pending = null;
    return SystemClock.elapsedRealtime() < attempt.expires ? attempt : null;
  }

  public Approval exchange(Uri callback, Purpose expected, BooleanSupplier active) throws Exception {
    Pending attempt = redeem(callback);
    if (attempt == null || attempt.purpose != expected) throw new IOException("Password backup approval expired");
    BooleanSupplier current = () -> {
      if (!active.getAsBoolean()) return false;
      try { return attempt.account.equals(accounts.session()); }
      catch (Exception unavailable) { return false; }
    };
    if (!current.getAsBoolean()) throw new IOException("Password backup account changed");
    JSONObject input = new JSONObject()
        .put("clientId", clientId).put("environment", environment)
        .put("redirectUri", accounts.passwordBackupCallback().toString()).put("purpose", expected.value)
        .put("state", attempt.state).put("verifier", attempt.verifier)
        .put("code", callback.getQueryParameter("code"));
    HttpsURLConnection request = connect(accounts.passwordBackupEndpoint(PATH + "/exchange"), "POST", attempt.account.token());
    try {
      send(request, "application/json", input.toString().getBytes(StandardCharsets.UTF_8));
      if (request.getResponseCode() != 200 || !current.getAsBoolean()) throw new IOException("Password backup approval was refused");
      JSONObject output = new JSONObject(new String(body(request, 8192), StandardCharsets.UTF_8));
      Object code = output.get("code"), revisionValue = output.get("revision");
      String scope = output.getString("scope"), owner = output.getString("ownerId");
      String revision = revisionValue instanceof String ? (String) revisionValue : null;
      Object present = output.get("present");
      if ((expected == Purpose.VERIFY ? code != JSONObject.NULL : !(code instanceof String granted && granted.matches(CODE)))
          || !scope.matches("[a-f0-9]{64}") || !attempt.account.accountId().equals(owner) || !(present instanceof Boolean)
          || (revision == null && revisionValue != JSONObject.NULL)
          || (revision != null && !revision.matches("\"[1-9][0-9]{0,9}\""))
          || (Boolean.TRUE.equals(present) && revision == null)) {
        throw new IOException("Invalid password backup approval");
      }
      return new Approval(accounts.passwordBackupEndpoint(PATH), expected, code instanceof String value ? value : null,
        attempt.state, attempt.verifier, scope, owner, revision, Boolean.TRUE.equals(present), current);
    } finally {
      request.disconnect();
    }
  }

  private static String randomValue() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static HttpsURLConnection connect(URI endpoint, String method, String bearer) throws IOException {
    HttpsURLConnection request = (HttpsURLConnection) endpoint.toURL().openConnection();
    request.setRequestMethod(method);
    request.setInstanceFollowRedirects(false);
    request.setUseCaches(false);
    request.setConnectTimeout(TIMEOUT_MS);
    request.setReadTimeout(TIMEOUT_MS);
    if (bearer != null) request.setRequestProperty("Authorization", "Bearer " + bearer);
    return request;
  }

  private static void send(HttpsURLConnection request, String contentType, byte[] bytes) throws IOException {
    request.setRequestProperty("Content-Type", contentType);
    request.setDoOutput(true);
    request.setFixedLengthStreamingMode(bytes.length);
    try (var output = request.getOutputStream()) {
      output.write(bytes);
    }
  }

  private static byte[] body(HttpsURLConnection request, int maxBytes) throws IOException {
    if (request.getContentLengthLong() > maxBytes) throw new IOException("Password backup response is too large");
    try (InputStream input = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (count > maxBytes - output.size()) throw new IOException("Password backup response is too large");
        output.write(buffer, 0, count);
      }
      if (output.size() == 0) throw new IOException("Password backup response is empty");
      return output.toByteArray();
    }
  }
}
