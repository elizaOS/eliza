// spec/os/android/passwords/vault.md, "One native proof authorizes one backup action"; spec/os/android/passwords/vault.md, "Shared backup is offered only when its exact native app is ready"
package ai.eliza.auth.cloud;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
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
    private final String organizationId;
    private final String revision;
    private final boolean present;
    private final BooleanSupplier current;
    private boolean spent;

    private Approval(URI endpoint, Purpose purpose, String code, String state, String verifier, String scope, String ownerId, String organizationId, String revision, boolean present, BooleanSupplier current) {
      this.endpoint = endpoint;
      this.purpose = purpose;
      this.code = code;
      this.state = state;
      this.verifier = verifier;
      this.scope = scope;
      this.ownerId = ownerId;
      this.organizationId = organizationId;
      this.revision = revision;
      this.present = present;
      this.current = current;
    }

    public String scope() { return scope; }
    public String ownerId() { return ownerId; }
    public String organizationId() { return organizationId; }
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
          byte[] downloaded = body(request, MAX_SNAPSHOT_BYTES);
          if (!current()) {
            java.util.Arrays.fill(downloaded, (byte) 0);
            throw new IOException("Password backup closed");
          }
          return new Response(status, revision, downloaded);
        }
        if (status == 204 && revision == null) throw new IOException("Missing password backup revision");
        return new Response(status, revision, null);
      } finally {
        request.disconnect();
      }
    }
  }

  private CloudPasswordBackup() {}

  static Approval approve(
      CloudSignInConfig config, CloudSignInEnvironment environment, String freshSession, Purpose purpose, BooleanSupplier current
  ) throws Exception {
    if (!current.getAsBoolean() || !config.environments().contains(environment) || !CloudSignInFlow.validStewardToken(freshSession)
        || freshSession.startsWith("eliza_") || freshSession.startsWith("pbackup_")) {
      throw new IOException("A fresh account sign-in is required");
    }
    String verifier = CloudSignInFlow.newVerifier();
    String state = CloudSignInFlow.newState();
    URI endpoint = URI.create(environment.api() + PATH);
    JSONObject input = new JSONObject()
        .put("clientId", config.clientId).put("environment", environment.name)
        .put("redirectUri", environment.callback()).put("purpose", purpose.value)
        .put("state", state).put("codeChallenge", CloudSignInFlow.s256(verifier))
        .put("codeChallengeMethod", "S256");
    HttpsURLConnection request = connect(endpoint, "POST", freshSession);
    try {
      send(request, "application/json", input.toString().getBytes(StandardCharsets.UTF_8));
      if (request.getResponseCode() != 200) throw new IOException("Password backup approval was refused");
      JSONObject output = new JSONObject(new String(body(request, 8192), StandardCharsets.UTF_8));
      String code = output.getString("code"), scope = output.getString("scope");
      String owner = output.getString("ownerId");
      String organization = output.optString("organizationId", null);
      Object revisionValue = output.opt("revision");
      String revision = revisionValue instanceof String ? (String) revisionValue : null;
      Object present = output.opt("present");
      if (!code.matches("pbackup_[A-Za-z0-9_-]{43}") || !scope.matches("[a-f0-9]{64}")
          || !CloudSignInFlow.validUuid(owner) || !CloudSignInFlow.validUuid(organization)
          || !(present instanceof Boolean) || !output.has("revision")
          || (revision == null && revisionValue != JSONObject.NULL)
          || (revision != null && !revision.matches("\"[1-9][0-9]{0,9}\""))
          || (Boolean.TRUE.equals(present) && revision == null)) {
        throw new IOException("Invalid password backup approval");
      }
      if (!current.getAsBoolean()) throw new IOException("Password backup closed");
      return new Approval(endpoint, purpose, code, state, verifier, scope, owner, organization, revision, Boolean.TRUE.equals(present), current);
    } finally {
      request.disconnect();
    }
  }

  public static boolean available(CloudSignInConfig config, CloudSignInEnvironment environment) {
    if (!config.environments().contains(environment)) return false;
    try {
      URI url = URI.create(environment.api() + PATH + "/readiness?clientId=" + config.clientId);
      HttpsURLConnection request = connect(url, "GET", null);
      try {
        if (request.getResponseCode() != 204 || !"2".equals(request.getHeaderField("X-Password-Backup-Version"))) return false;
      } finally {
        request.disconnect();
      }
      String tenant = URLEncoder.encode(environment.tenant, StandardCharsets.UTF_8.name());
      String client = URLEncoder.encode(config.googleClientId, StandardCharsets.UTF_8.name());
      URI providers = URI.create(environment.api() + "/steward/auth/providers?tenantId=" + tenant + "&clientId=" + client);
      HttpsURLConnection discovery = connect(providers, "GET", null);
      try {
        if (discovery.getResponseCode() != 200) return false;
        JSONObject response = new JSONObject(new String(body(discovery, 16384), StandardCharsets.UTF_8));
        JSONObject nativeGoogle = response.optJSONObject("nativeGoogleApp");
        return nativeGoogle != null && config.googleClientId.equals(nativeGoogle.optString("clientId"))
          && Boolean.TRUE.equals(nativeGoogle.opt("ready"));
      } finally {
        discovery.disconnect();
      }
    } catch (Exception unavailable) {
      return false;
    }
  }

  public static String currentAccount(CloudSignInEnvironment environment, String cloudKey) throws Exception {
    if (!CloudSignInFlow.validMobileSecret(cloudKey)) throw new IOException("Sign in to Grace first");
    URI endpoint = URI.create(environment.api() + "/api/v1/app-auth/session");
    HttpsURLConnection request = connect(endpoint, "GET", cloudKey);
    try {
      if (request.getResponseCode() != 200) throw new IOException("Sign in to Grace first");
      JSONObject session = new JSONObject(new String(body(request, 8192), StandardCharsets.UTF_8));
      JSONObject user = session.optJSONObject("user");
      String id = user == null ? "" : user.getString("id");
      if (!CloudSignInFlow.validUuid(id)) throw new IOException("Invalid password backup account");
      return id;
    } finally {
      request.disconnect();
    }
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
