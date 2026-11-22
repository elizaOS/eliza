// spec/os/signIn/cloudRequests.md, "A session-only route is sent only with a live account session, never with the device key"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A 401 goes to the credential with its reason and is not retried"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"; spec/os/signIn/cloudRequests.md, "A cancel disconnects only the page's own call still in flight, which then settles once as cancelled"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CloudRequestPolicy.Attach;
import ai.eliza.plugins.signin.CloudRequestPolicy.Handoff;
import ai.eliza.plugins.signin.CloudRequestPolicy.Holding;
import ai.eliza.plugins.signin.CloudRequestPolicy.KeyRejected;
import ai.eliza.plugins.signin.CloudRequestPolicy.Planned;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refusal;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refuse;
import ai.eliza.plugins.signin.CloudRequestPolicy.RefreshSessionFirst;
import ai.eliza.plugins.signin.CloudRequestPolicy.Send;
import ai.eliza.plugins.signin.CloudRequestPolicy.SessionRejected;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithKey;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithSession;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class CloudRequests {
  public record Custody(DeviceCredentialStore credentials, AccountSession session) {}

  public sealed interface Outcome permits Answered, Failed {}
  public record Answered(int status, String etag, String contentType, String retryAfter, byte[] body, LargeBodyGrant.Grant grant) implements Outcome {}
  public record Failed(Failure failure) implements Outcome {}

  public enum Failure {
    NO_ORIGIN, NOT_LISTED, BODY_TOO_LARGE, HEADER_REFUSED, SIGN_IN_REQUIRED, REAUTH_REQUIRED, REPLY_TOO_LARGE, NETWORK, NAME_IN_USE, CANCELLED;
    static Failure of(Refusal refusal) {
      return switch (refusal) {
        case NO_ORIGIN -> NO_ORIGIN;
        case NOT_LISTED -> NOT_LISTED;
        case BODY_TOO_LARGE -> BODY_TOO_LARGE;
        case HEADER_REFUSED -> HEADER_REFUSED;
        case SIGN_IN_REQUIRED -> SIGN_IN_REQUIRED;
        case REAUTH_REQUIRED -> REAUTH_REQUIRED;
      };
    }
  }

  private static final int TIMEOUT_MS = 30_000;
  private static final int UNAUTHORIZED = 401;

  private static final class Call {
    volatile HttpURLConnection connection;
    volatile boolean cancelled;
  }

  private final CloudRequestPolicy policy;
  private final LargeBodyGrant grants;
  private final Map<String, Call> calls = new ConcurrentHashMap<>();

  public CloudRequests(CloudRequestPolicy policy, LargeBodyGrant grants) {
    this.policy = policy;
    this.grants = grants;
  }

  public boolean cancel(String name) {
    Call call = name == null ? null : calls.get(name);
    if (call == null || call.cancelled) return false;
    call.cancelled = true;
    HttpURLConnection connection = call.connection;
    if (connection != null) connection.disconnect();
    return true;
  }

  public Outcome send(String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body) {
    return send(null, apiOrigin, custody, method, target, headers, body);
  }

  public Outcome send(String name, String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body) {
    Call call = new Call();
    if (name != null && calls.putIfAbsent(name, call) != null) return new Failed(Failure.NAME_IN_USE);
    try {
      Outcome outcome = sent(call, apiOrigin, custody, method, target, headers, body);
      return call.cancelled ? new Failed(Failure.CANCELLED) : outcome;
    } finally {
      if (name != null) calls.remove(name, call);
    }
  }

  private Outcome sent(Call call, String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body) {
    DeviceCredentialStore store = custody.credentials();
    CredentialReader.Credential key = store.current();
    int version = key == null ? 0 : key.version();
    CloudRequestPolicy.Origin origin = CloudRequestPolicy.originOf(apiOrigin);
    Planned planned = policy.plan(new Holding(version, false, false), origin, method, target, headers, body);
    String session = null;
    if (planned.plan() instanceof Refuse refuse && refuse.why() == Refusal.REAUTH_REQUIRED) {
      session = custody.session().accessToken();
      planned = policy.plan(new Holding(version, session != null, session != null), origin, method, target, headers, body);
    }
    Attach attach;
    switch (planned.plan()) {
      case Refuse refuse -> { return new Failed(Failure.of(refuse.why())); }
      case RefreshSessionFirst refresh -> { return new Failed(Failure.REAUTH_REQUIRED); }
      case Send send -> attach = send.attach();
    }
    String bearer = switch (attach) {
      case WithKey k -> key.value();
      case WithSession s -> session;
      case CloudRequestPolicy.Bare b -> null;
    };
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) URI.create(apiOrigin + target).toURL().openConnection();
      call.connection = connection;
      if (call.cancelled) return new Failed(Failure.CANCELLED);
      connection.setInstanceFollowRedirects(false);
      connection.setUseCaches(false);
      connection.setConnectTimeout(TIMEOUT_MS);
      connection.setReadTimeout(TIMEOUT_MS);
      connection.setRequestMethod(method);
      for (Map.Entry<String, String> header : planned.headers().entrySet()) connection.setRequestProperty(header.getKey(), header.getValue());
      if (bearer != null) connection.setRequestProperty(CloudRequestPolicy.AUTHORIZATION, "Bearer " + bearer);
      if (body != null) {
        if (!planned.headers().containsKey("Content-Type")) connection.setRequestProperty("Content-Type", "application/json");
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = connection.getOutputStream()) { out.write(body); }
      }
      int status = connection.getResponseCode();
      Answered answered = answer(connection, status);
      if (status == UNAUTHORIZED) {
        String text = answered.body() == null ? null : new String(answered.body(), StandardCharsets.UTF_8);
        switch (CloudRequestPolicy.reportOf(attach, planned.route(), status, CloudRequestPolicy.reasonOf(text))) {
          case KeyRejected rejected -> store.rejected(rejected.version(), rejected.reason(), rejected.on());
          case SessionRejected rejected -> custody.session().drop();
          case CloudRequestPolicy.NoReport none -> { }
        }
      }
      return answered;
    } catch (LargeBodyGrant.Oversize oversize) {
      return new Failed(Failure.REPLY_TOO_LARGE);
    } catch (IllegalArgumentException unaddressable) {
      return new Failed(Failure.NOT_LISTED);
    } catch (IOException unanswered) {
      return new Failed(Failure.NETWORK);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private Answered answer(HttpURLConnection connection, int status) throws IOException {
    String etag = connection.getHeaderField("ETag"), contentType = connection.getContentType(), retryAfter = connection.getHeaderField("Retry-After");
    if (CloudRequestPolicy.handoffOf(connection.getContentLengthLong()) == Handoff.REPLY_TOO_LARGE) throw new LargeBodyGrant.Oversize();
    InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
    if (stream == null) return new Answered(status, etag, contentType, retryAfter, new byte[0], null);
    try (InputStream in = stream) {
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 << 10];
      for (int n; (n = in.read(buffer, 0, (int) Math.min(buffer.length, CloudRequestPolicy.INLINE_LIMIT + 1 - head.size()))) > 0;) {
        head.write(buffer, 0, n);
        if (CloudRequestPolicy.handoffOf(head.size()) == Handoff.CACHED_BODY)
          return new Answered(status, etag, contentType, retryAfter, null, grants.spill(head.toByteArray(), in, contentType));
      }
      return new Answered(status, etag, contentType, retryAfter, head.toByteArray(), null);
    }
  }
}
