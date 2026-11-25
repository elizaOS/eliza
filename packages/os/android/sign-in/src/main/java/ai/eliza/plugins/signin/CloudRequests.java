// spec/os/signIn/cloudRequests.md, "A session-only route is sent only with a live account session, never with the device key"; spec/os/signIn/cloudRequests.md, "A mail or calendar route is sent only with the lease, never with the device key"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A 401 goes to the credential with its reason and is not retried"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"; spec/os/signIn/cloudRequests.md, "A cancel disconnects only the page's own call still in flight, which then settles once as cancelled"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CloudRequestPolicy.Attach;
import ai.eliza.plugins.signin.CloudRequestPolicy.Handoff;
import ai.eliza.plugins.signin.CloudRequestPolicy.Holding;
import ai.eliza.plugins.signin.CloudRequestPolicy.KeyRejected;
import ai.eliza.plugins.signin.CloudRequestPolicy.LeaseRejected;
import ai.eliza.plugins.signin.CloudRequestPolicy.RefreshLeaseFirst;
import ai.eliza.plugins.signin.CloudRequestPolicy.Planned;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refusal;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refuse;
import ai.eliza.plugins.signin.CloudRequestPolicy.RefreshSessionFirst;
import ai.eliza.plugins.signin.CloudRequestPolicy.Send;
import ai.eliza.plugins.signin.CloudRequestPolicy.SessionRejected;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithKey;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithLease;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseUse;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithSession;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class CloudRequests {
  public record MailAuthority(CredentialPolicy.Account account, int version) {}

  public record Custody(DeviceCredentialStore credentials, AccountSession session, DeviceLease lease) {
    public MailAuthority mailAuthority() { return authorityOf(credentials.state()); }
  }

  private static MailAuthority authorityOf(CredentialPolicy.State state) {
    int version = CredentialPolicy.leaseVersionOf(state.lease());
    return version > 0 && version == CredentialPolicy.activeVersion(state)
      ? new MailAuthority(CredentialPolicy.accountOf(state), version) : null;
  }

  public sealed interface Outcome permits Answered, Failed {}
  public record Answered(int status, String etag, String contentType, String retryAfter, byte[] body, LargeBodyGrant.Grant grant) implements Outcome {}
  public record Failed(Failure failure) implements Outcome {}

  public enum Failure {
    NO_ORIGIN, NOT_LISTED, BODY_TOO_LARGE, HEADER_REFUSED, SIGN_IN_REQUIRED, MAIL_LEASE_UPGRADE_REQUIRED, REAUTH_REQUIRED, REPLY_TOO_LARGE, NETWORK, NAME_IN_USE, CANCELLED;
    static Failure of(Refusal refusal) {
      return switch (refusal) {
        case NO_ORIGIN -> NO_ORIGIN;
        case NOT_LISTED -> NOT_LISTED;
        case BODY_TOO_LARGE -> BODY_TOO_LARGE;
        case HEADER_REFUSED -> HEADER_REFUSED;
        case SIGN_IN_REQUIRED -> SIGN_IN_REQUIRED;
        case MAIL_LEASE_UPGRADE_REQUIRED -> MAIL_LEASE_UPGRADE_REQUIRED;
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

  public static CloudRequests forMailReads(File cacheDirectory) {
    return new CloudRequests(CloudRequestPolicy.forMailReads(), new LargeBodyGrant(cacheDirectory));
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
    return send(name, apiOrigin, custody, method, target, headers, body, null);
  }

  public Outcome send(String name, String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body,
      String expectedCredentialId) {
    return send(name, apiOrigin, custody, method, target, headers, body, expectedCredentialId, false);
  }

  public Outcome send(String name, String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body,
      String expectedCredentialId, boolean billingSession) {
    if (billingSession && expectedCredentialId == null) return new Failed(Failure.SIGN_IN_REQUIRED);
    Call call = new Call();
    if (name != null && calls.putIfAbsent(name, call) != null) return new Failed(Failure.NAME_IN_USE);
    try {
      Outcome outcome = sent(call, apiOrigin, custody, method, target, headers, body, null, expectedCredentialId, billingSession);
      return call.cancelled ? new Failed(Failure.CANCELLED) : outcome;
    } finally {
      if (name != null) calls.remove(name, call);
    }
  }

  public Outcome readMail(String apiOrigin, Custody custody, MailAuthority expected, String target, Map<String, String> headers) {
    if (expected == null) return new Failed(Failure.SIGN_IN_REQUIRED);
    return sent(new Call(), apiOrigin, custody, "GET", target, headers, null, expected, null, false);
  }

  private static boolean keepsCredential(CredentialReader.Credential key, CredentialPolicy.State state, String expected) {
    return key != null && state.custody() instanceof CredentialPolicy.Custody.Active active
      && key.version() == active.version() && expected.equals(key.credentialId()) && expected.equals(active.credentialId());
  }

  private Outcome sent(Call call, String apiOrigin, Custody custody, String method, String target, Map<String, String> headers, byte[] body,
      MailAuthority expected, String expectedCredentialId, boolean billingSession) {
    DeviceCredentialStore store = custody.credentials();
    CredentialReader.Credential key = store.current();
    CredentialPolicy.State snapshot = store.state();
    if (expectedCredentialId != null && !keepsCredential(key, snapshot, expectedCredentialId)) return new Failed(Failure.SIGN_IN_REQUIRED);
    if (expected != null && !expected.equals(authorityOf(snapshot))) return new Failed(Failure.SIGN_IN_REQUIRED);
    int active = CredentialPolicy.activeVersion(snapshot);
    int version = key == null || key.version() != active ? 0 : active;
    CloudRequestPolicy.Origin origin = CloudRequestPolicy.originOf(apiOrigin);
    boolean leaseHeld = CredentialPolicy.leaseVersionOf(snapshot.lease()) >= 1;
    Planned planned = policy.plan(new Holding(version, false, false, leaseHeld, false), origin, method, target, headers, body);
    if ((expected != null && planned.route().auth() != CloudRequestPolicy.Auth.MAIL)
        || (billingSession && planned.route().auth() != CloudRequestPolicy.Auth.FRESH_SESSION)) return new Failed(Failure.NOT_LISTED);
    String session = null;
    DeviceLease.Held lease = null;
    if (planned.plan() instanceof Refuse refuse && refuse.why() == Refusal.REAUTH_REQUIRED) {
      session = custody.session().accessToken();
      planned = policy.plan(new Holding(version, session != null, session != null, leaseHeld, false), origin, method, target, headers, body);
    } else if (planned.plan() instanceof RefreshLeaseFirst) {
      lease = custody.lease().accessToken();
      CredentialPolicy.State current = store.state();
      if (expected != null && !expected.equals(authorityOf(current))) return new Failed(Failure.SIGN_IN_REQUIRED);
      int leaseVersion = CredentialPolicy.leaseVersionOf(current.lease());
      boolean bound = lease != null && lease.version() == leaseVersion && CredentialPolicy.leaseUsable(current);
      planned = policy.plan(new Holding(CredentialPolicy.activeVersion(current), false, false, leaseVersion >= 1, bound), origin, method, target, headers, body);
    }
    Attach attach;
    switch (planned.plan()) {
      case Refuse refuse -> { return new Failed(Failure.of(refuse.why())); }
      case RefreshSessionFirst refresh -> { return new Failed(Failure.REAUTH_REQUIRED); }
      case RefreshLeaseFirst refresh -> { return new Failed(Failure.NETWORK); }
      case Send send -> attach = send.attach();
    }
    if (expectedCredentialId != null && (billingSession ? !(attach instanceof WithSession) : !(attach instanceof WithKey))) {
      return new Failed(Failure.SIGN_IN_REQUIRED);
    }
    String bearer = switch (attach) {
      case WithKey k -> key.value();
      case WithSession s -> session;
      case WithLease l -> lease.token();
      case CloudRequestPolicy.Bare b -> null;
    };
    HttpURLConnection connection = null;
    try {
      if (expected != null && !expected.equals(custody.mailAuthority())) return new Failed(Failure.SIGN_IN_REQUIRED);
      if (expectedCredentialId != null && !keepsCredential(key, store.state(), expectedCredentialId)) return new Failed(Failure.SIGN_IN_REQUIRED);
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
      if (expected != null && !expected.equals(custody.mailAuthority())) return new Failed(Failure.SIGN_IN_REQUIRED);
      if (billingSession && !keepsCredential(key, store.state(), expectedCredentialId)) return new Failed(Failure.SIGN_IN_REQUIRED);
      Answered answered = answer(connection, status, expected == null && !billingSession);
      if (expected != null && !expected.equals(custody.mailAuthority())) return new Failed(Failure.SIGN_IN_REQUIRED);
      if (billingSession && !keepsCredential(key, store.state(), expectedCredentialId)) return new Failed(Failure.SIGN_IN_REQUIRED);
      if (status == UNAUTHORIZED) {
        String text = answered.body() == null ? null : new String(answered.body(), StandardCharsets.UTF_8);
        switch (CloudRequestPolicy.reportOf(attach, planned.route(), status, CloudRequestPolicy.reasonOf(text))) {
          case KeyRejected rejected -> store.rejected(rejected.version(), rejected.reason(), rejected.on());
          case LeaseRejected rejected -> store.leaseRejected(rejected.version(), rejected.reason(), LeaseUse.ACCESS_USE);
          case SessionRejected rejected -> custody.session().dropIfCurrent(session);
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

  private Answered answer(HttpURLConnection connection, int status, boolean allowGrant) throws IOException {
    String etag = connection.getHeaderField("ETag"), contentType = connection.getContentType(), retryAfter = connection.getHeaderField("Retry-After");
    long limit = allowGrant ? CloudRequestPolicy.REPLY_LIMIT : CloudRequestPolicy.INLINE_LIMIT;
    if (connection.getContentLengthLong() > limit) throw new LargeBodyGrant.Oversize();
    InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
    if (stream == null) return new Answered(status, etag, contentType, retryAfter, new byte[0], null);
    try (InputStream in = stream) {
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      byte[] buffer = new byte[64 << 10];
      for (int n; (n = in.read(buffer, 0, (int) Math.min(buffer.length, CloudRequestPolicy.INLINE_LIMIT + 1 - head.size()))) > 0;) {
        head.write(buffer, 0, n);
        if (CloudRequestPolicy.handoffOf(head.size()) == Handoff.CACHED_BODY) {
          if (!allowGrant) throw new LargeBodyGrant.Oversize();
          return new Answered(status, etag, contentType, retryAfter, null, grants.spill(head.toByteArray(), in, contentType));
        }
      }
      return new Answered(status, etag, contentType, retryAfter, head.toByteArray(), null);
    }
  }
}
