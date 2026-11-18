// spec/os/signIn/cloudRequests.md, "Story: Reach my account's cloud services without holding my key"; spec/os/signIn/credential.md, "An expired key keeps the account, and only the account read signs out on a revoked or unknown key"; spec/os/signIn/credential.md, "An account session is held in memory only for the active key's account, for at most one hour"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CloudRequestPolicy.Admitted;
import ai.eliza.plugins.signin.CloudRequestPolicy.Failure;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refused;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public final class CloudRequests {
  public interface Custody {
    Key deviceKey(String apiOrigin);
    String accountSession(String apiOrigin);
    void keyRejected(String apiOrigin, long version, String reason);
    void sessionRejected(String apiOrigin);
  }

  public record Key(long version, String value) {}

  public sealed interface Outcome permits Answered, Failed {}
  public record Answered(int status, String etag, String contentType, byte[] body, LargeBodyGrant.Grant grant) implements Outcome {}
  public record Failed(Failure failure) implements Outcome {}

  private static final int TIMEOUT_MS = 30_000;
  private static final int UNAUTHORIZED = 401;

  private final CloudRequestPolicy policy;
  private final String apiOrigin;
  private final Custody custody;
  private final LargeBodyGrant grants;

  public CloudRequests(CloudRequestPolicy policy, String apiOrigin, Custody custody, LargeBodyGrant grants) {
    this.policy = policy;
    this.apiOrigin = apiOrigin;
    this.custody = custody;
    this.grants = grants;
  }

  public Outcome send(String method, String target, Map<String, String> headers, byte[] body) {
    CloudRequestPolicy.Decision decision = policy.admit(method, target, headers, body);
    if (decision instanceof Refused refused) return new Failed(refused.failure());
    Admitted admitted = (Admitted) decision;
    Key key = null;
    String bearer = null;
    switch (admitted.credential()) {
      case DEVICE_KEY -> {
        key = custody.deviceKey(apiOrigin);
        if (key == null) return new Failed(Failure.SIGNED_OUT);
        bearer = key.value();
      }
      case ACCOUNT_SESSION -> {
        bearer = custody.accountSession(apiOrigin);
        if (bearer == null) return new Failed(Failure.REAUTH_REQUIRED);
      }
      case NONE -> { }
    }
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(apiOrigin + target).openConnection();
      connection.setInstanceFollowRedirects(false);
      connection.setUseCaches(false);
      connection.setConnectTimeout(TIMEOUT_MS);
      connection.setReadTimeout(TIMEOUT_MS);
      connection.setRequestMethod(method);
      if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
      for (Map.Entry<String, String> header : admitted.headers().entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
      if (body != null) {
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = connection.getOutputStream()) { out.write(body); }
      }
      int status = connection.getResponseCode();
      Answered answered = answer(connection, status);
      if (status == UNAUTHORIZED) {
        switch (admitted.credential()) {
          case DEVICE_KEY -> custody.keyRejected(apiOrigin, key.version(), CloudRequestPolicy.credentialReason(text(answered.body())));
          case ACCOUNT_SESSION -> custody.sessionRejected(apiOrigin);
          case NONE -> { }
        }
      }
      return answered;
    } catch (LargeBodyGrant.Oversize oversize) {
      return new Failed(Failure.TOO_LARGE);
    } catch (IOException unanswered) {
      return new Failed(Failure.NETWORK);
    } catch (Oversized declared) {
      return new Failed(Failure.TOO_LARGE);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private Answered answer(HttpURLConnection connection, int status) throws IOException {
    String etag = connection.getHeaderField("ETag"), contentType = connection.getContentType();
    if (CloudRequestPolicy.deliveryOf(connection.getContentLengthLong()) == CloudRequestPolicy.Delivery.TOO_LARGE) throw new Oversized();
    InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
    if (stream == null) return new Answered(status, etag, contentType, new byte[0], null);
    try (InputStream in = stream) {
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 << 10];
      for (int n; (n = in.read(buffer, 0, (int) Math.min(buffer.length, CloudRequestPolicy.INLINE_LIMIT + 1 - head.size()))) > 0;) {
        head.write(buffer, 0, n);
        if (head.size() > CloudRequestPolicy.INLINE_LIMIT) return new Answered(status, etag, contentType, null, grants.spill(head.toByteArray(), in, contentType));
      }
      return new Answered(status, etag, contentType, head.toByteArray(), null);
    }
  }

  private static String text(byte[] body) { return body == null ? null : new String(body, StandardCharsets.UTF_8); }

  private static final class Oversized extends RuntimeException {}
}
