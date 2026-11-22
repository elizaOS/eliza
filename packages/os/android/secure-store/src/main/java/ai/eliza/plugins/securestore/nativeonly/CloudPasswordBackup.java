package ai.eliza.plugins.securestore.nativeonly;

import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Purpose;
import android.net.Uri;
import android.os.SystemClock;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Objects;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

public final class CloudPasswordBackup {
  private static final String PATH = "/api/v1/app-auth/mobile/password-backup";
  private static final String CODE = "pbackup_[A-Za-z0-9_-]{43}";
  private static final long APPROVAL_MILLIS = 5 * 60_000L;
  @FunctionalInterface
  public interface AccountBinding {
    CloudDeviceAccount.Session session() throws Exception;
  }

  private final AccountBinding accountBinding;
  private final URI apiOrigin;
  private final Uri callback;
  private final String clientId;
  private final String environment;
  private Pending pending;

  private record Pending(CloudDeviceAccount.Session account, Purpose purpose, String verifier, String state, long expires) {}

  public CloudPasswordBackup(CloudDeviceAccount accounts, String clientId, String environment) {
    this(accounts::session, accounts.passwordBackupOrigin(), accounts.passwordBackupCallback(), clientId, environment);
  }

  public CloudPasswordBackup(AccountBinding accountBinding, URI apiOrigin, Uri callback, String clientId, String environment) {
    if (!clientId.matches("[a-z][a-z0-9.-]{0,127}") || !environment.matches("[a-z][a-z0-9-]{0,63}")) {
      throw new IllegalArgumentException("Invalid password backup profile");
    }
    if (!"https".equals(callback.getScheme()) || callback.getHost() == null
        || !callback.getHost().equals(callback.getEncodedAuthority()) || callback.getEncodedPath() == null
        || !callback.getEncodedPath().matches("(?:/[a-z][a-z0-9-]*)+")
        || callback.getEncodedQuery() != null || callback.getEncodedFragment() != null) {
      throw new IllegalArgumentException("Invalid password backup callback");
    }
    this.accountBinding = Objects.requireNonNull(accountBinding);
    this.apiOrigin = CloudDeviceAccount.origin(apiOrigin.toString());
    this.callback = callback;
    this.clientId = clientId;
    this.environment = environment;
  }

  public static boolean isBackupReturn(Uri data) {
    if (data == null) return false;
    return data.getQueryParameters("code").stream().anyMatch(code -> code.startsWith("pbackup_"));
  }

  public synchronized Uri begin(Purpose purpose) throws Exception {
    CloudDeviceAccount.Session account = accountBinding.session();
    if (account == null) throw new IOException("Sign in on this device first");
    String verifier = randomValue(), state = randomValue();
    String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(
      MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    pending = new Pending(account, purpose, verifier, state, SystemClock.elapsedRealtime() + APPROVAL_MILLIS);
    return Uri.parse(apiOrigin.resolve(PATH + "/approve").toString()).buildUpon()
      .appendQueryParameter("clientId", clientId).appendQueryParameter("environment", environment)
      .appendQueryParameter("redirectUri", this.callback.toString())
      .appendQueryParameter("state", state).appendQueryParameter("codeChallenge", challenge)
      .appendQueryParameter("codeChallengeMethod", "S256").appendQueryParameter("purpose", purpose.value()).build();
  }

  public synchronized void cancel() { pending = null; }

  public boolean available() {
    try {
      if (accountBinding.session() == null) return false;
      URI endpoint = URI.create(apiOrigin.resolve(PATH + "/readiness") + "?clientId=" + clientId +
        "&environment=" + environment);
      HttpsURLConnection request = PasswordBackupApproval.connect(endpoint, "GET", null);
      try { return request.getResponseCode() == 204; }
      finally { request.disconnect(); }
    } catch (Exception unavailable) {
      return false;
    }
  }

  public synchronized boolean accepts(Uri callback) {
    if (!CloudDeviceAccount.matchesCallback(this.callback, callback) || callback.getQueryParameters("code").size() != 1
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

  public PasswordBackupApproval exchange(Uri callback, Purpose expected, BooleanSupplier active) throws Exception {
    Pending attempt = redeem(callback);
    if (attempt == null || attempt.purpose != expected) throw new IOException("Password backup approval expired");
    BooleanSupplier current = () -> {
      if (!active.getAsBoolean()) return false;
      try { return attempt.account.equals(accountBinding.session()); }
      catch (Exception unavailable) { return false; }
    };
    if (!current.getAsBoolean()) throw new IOException("Password backup account changed");
    JSONObject input = new JSONObject()
        .put("clientId", clientId).put("environment", environment)
        .put("redirectUri", this.callback.toString()).put("purpose", expected.value())
        .put("state", attempt.state).put("verifier", attempt.verifier)
        .put("code", callback.getQueryParameter("code"));
    HttpsURLConnection request = PasswordBackupApproval.connect(apiOrigin.resolve(PATH + "/exchange"), "POST", attempt.account.token());
    try {
      PasswordBackupApproval.send(request, "application/json", input.toString().getBytes(StandardCharsets.UTF_8));
      if (request.getResponseCode() != 200) throw new IOException("Password backup approval was refused");
      JSONObject output = new JSONObject(new String(PasswordBackupApproval.body(request, 8192), StandardCharsets.UTF_8));
      var grant = new PasswordBackupApproval.Grant(field(output, "code"), output.optString("scope", null), output.optString("ownerId", null),
        field(output, "organizationId"), field(output, "revision"), field(output, "present"));
      var owner = new PasswordBackupApproval.Owner(attempt.account.accountId(), attempt.account.organizationId());
      return PasswordBackupApproval.admit(apiOrigin.resolve(PATH), expected, attempt.state, attempt.verifier, owner, grant, current);
    } finally {
      request.disconnect();
    }
  }

  private static Object field(JSONObject output, String name) throws IOException {
    if (!output.has(name)) throw new IOException("Invalid password backup approval");
    Object value = output.opt(name);
    return value == JSONObject.NULL ? null : value;
  }

  private static String randomValue() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }
}
