// spec/os/android/passwords/vault.md, "Shared approval requires the registered cloud and the current owner"; spec/os/android/passwords/vault.md, "One native proof authorizes one backup action"
package ai.eliza.plugins.securestore.nativeonly;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.Arrays;
import java.util.function.BooleanSupplier;
import javax.net.ssl.HttpsURLConnection;

public final class PasswordBackupApproval {
  static final int MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
  private static final int TIMEOUT_MS = 10_000;
  private static final String CODE = "pbackup_[A-Za-z0-9_-]{43}";
  private static final String REVISION = "\"[1-9][0-9]{0,9}\"";

  public enum Purpose {
    READ("read", "GET"), SAVE("save", "PUT"), DELETE("delete", "DELETE"), VERIFY("verify", null);
    private final String value;
    private final String method;
    Purpose(String value, String method) { this.value = value; this.method = method; }
    public String value() { return value; }
  }

  public record Response(int status, String revision, byte[] ciphertext) {}

  public record Owner(String accountId, String organizationId) {}

  public record Grant(Object code, String scope, String ownerId, Object organizationId, Object revision, Object present) {}

  private final URI endpoint;
  private final Purpose purpose;
  private final String code;
  private final String state;
  private final String verifier;
  private final String scope;
  private final Owner owner;
  private final String revision;
  private final boolean present;
  private final BooleanSupplier current;
  private boolean spent;

  private PasswordBackupApproval(URI endpoint, Purpose purpose, String code, String state, String verifier, String scope, Owner owner, String revision, boolean present, BooleanSupplier current) {
    this.endpoint = endpoint;
    this.purpose = purpose;
    this.code = code;
    this.state = state;
    this.verifier = verifier;
    this.scope = scope;
    this.owner = owner;
    this.revision = revision;
    this.present = present;
    this.current = current;
  }

  public static PasswordBackupApproval admit(URI endpoint, Purpose purpose, String state, String verifier, Owner expected, Grant grant, BooleanSupplier current) throws IOException {
    String revision = grant.revision() instanceof String value ? value : null;
    boolean coded = purpose == Purpose.VERIFY ? grant.code() == null : grant.code() instanceof String value && value.matches(CODE);
    if (!coded || grant.scope() == null || !grant.scope().matches("[a-f0-9]{64}")
        || !expected.accountId().equals(grant.ownerId()) || !expected.organizationId().equals(grant.organizationId())
        || !(grant.present() instanceof Boolean present) || (revision == null && grant.revision() != null)
        || (revision != null && !revision.matches(REVISION)) || (present && revision == null)) {
      throw new IOException("Invalid password backup approval");
    }
    if (!current.getAsBoolean()) throw new IOException("Password backup account changed");
    return new PasswordBackupApproval(endpoint, purpose, grant.code() instanceof String value ? value : null,
      state, verifier, grant.scope(), expected, revision, present, current);
  }

  public static PasswordBackupApproval admitNative(URI endpoint, Purpose purpose, String state, String verifier, Owner expected, Grant grant, BooleanSupplier current) throws IOException {
    if (!(grant.code() instanceof String code) || !code.matches(CODE)) throw new IOException("Invalid native password backup approval");
    Grant operation = purpose == Purpose.VERIFY
      ? new Grant(null, grant.scope(), grant.ownerId(), grant.organizationId(), grant.revision(), grant.present())
      : grant;
    return admit(endpoint, purpose, state, verifier, expected, operation, current);
  }

  public static boolean advertisesNativeV2(URI endpoint) throws IOException {
    return advertisesNative(endpoint, "2");
  }

  public static boolean advertisesNative(URI endpoint, String version) throws IOException {
    HttpsURLConnection request = connect(endpoint, "GET", null);
    try {
      return request.getResponseCode() == 204 && version.equals(request.getHeaderField("X-Password-Backup-Version"));
    } finally {
      request.disconnect();
    }
  }

  public String scope() { return scope; }
  public String ownerId() { return owner.accountId(); }
  public String organizationId() { return owner.organizationId(); }
  public String revision() { return revision; }
  public boolean present() { return present; }
  public boolean current() { return current.getAsBoolean(); }

  public synchronized Response run(String expectedRevision, byte[] ciphertext) throws IOException {
    if (spent || purpose == Purpose.VERIFY || !current.getAsBoolean() || (expectedRevision != null && !expectedRevision.matches(REVISION))
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
      if (revision != null && !revision.matches(REVISION)) throw new IOException("Invalid password backup revision");
      if (purpose == Purpose.READ && status == 200) {
        if (revision == null || !"application/octet-stream".equals(request.getContentType())) {
          throw new IOException("Invalid password backup response");
        }
        byte[] downloaded = body(request, MAX_SNAPSHOT_BYTES);
        if (!current.getAsBoolean()) {
          Arrays.fill(downloaded, (byte) 0);
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

  static HttpsURLConnection connect(URI endpoint, String method, String bearer) throws IOException {
    HttpsURLConnection request = (HttpsURLConnection) endpoint.toURL().openConnection();
    request.setRequestMethod(method);
    request.setInstanceFollowRedirects(false);
    request.setUseCaches(false);
    request.setConnectTimeout(TIMEOUT_MS);
    request.setReadTimeout(TIMEOUT_MS);
    if (bearer != null) request.setRequestProperty("Authorization", "Bearer " + bearer);
    return request;
  }

  static void send(HttpsURLConnection request, String contentType, byte[] bytes) throws IOException {
    request.setRequestProperty("Content-Type", contentType);
    request.setDoOutput(true);
    request.setFixedLengthStreamingMode(bytes.length);
    try (var output = request.getOutputStream()) {
      output.write(bytes);
    }
  }

  static byte[] body(HttpsURLConnection request, int maxBytes) throws IOException {
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
