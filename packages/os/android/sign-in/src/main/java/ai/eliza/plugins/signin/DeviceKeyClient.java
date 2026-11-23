// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseUse;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.CredentialPolicy.RejectedOn;
import ai.eliza.plugins.signin.DeviceCredentialStore.HeldLease;
import ai.eliza.plugins.signin.DeviceCredentialStore.Kept;
import ai.eliza.plugins.signin.DeviceCredentialStore.LeaseSecret;
import ai.eliza.plugins.signin.DeviceCredentialStore.Owed;
import ai.eliza.plugins.signin.DeviceCredentialStore.Outcome;
import ai.eliza.plugins.signin.DeviceCredentialStore.Pending;
import ai.eliza.plugins.signin.DeviceCredentialStore.Token;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

public final class DeviceKeyClient {
  public static final String CONNECT = "/api/v1/app-auth/connect";
  public static final String TOKEN = "/api/v1/app-auth/mobile/token";
  public static final String ACK = "/api/v1/app-auth/mobile/ack";
  public static final String REVOKE = "/api/v1/api-keys/current";
  static final String RENEWED_CREDENTIAL = "X-Renewed-Credential-Id";
  public static final String LEASE = "/api/v1/app-auth/mobile/lease";
  public static final String RENEW = "/api/v1/app-auth/mobile/renew";
  public static final Pattern LEASE_REFRESH = Pattern.compile("eliza_lease_refresh_[A-Za-z0-9_-]{54}");
  public static final Pattern LEASE_ACCESS = Pattern.compile("eliza_lease_[A-Za-z0-9_-]{43}");
  public static final String USER = "/api/v1/user";
  public static final String CODE_CHALLENGE_METHOD = "S256";
  public static final int CONNECT_TIMEOUT_MS = 8_000;
  public static final int READ_TIMEOUT_MS = 10_000;
  public static final int MAX_BODY_BYTES = 16_384;
  public static final int ASKS = 3;
  public static final long BACKOFF_MS = 1_000L;

  public record Binding(String clientId, String environment, String redirectUri) {}

  public record Proof(String code, String state, String verifier) {
    @Override public String toString() { return "Proof[redacted]"; }
  }

  public record Grant(String code, long expiresAt) {
    @Override public String toString() { return "Grant[expiresAt=" + expiresAt + "]"; }
  }

  public record Acknowledgement(String credentialId, long expiresAt) {}

  public record Rotated(String access, long accessExpiresAt, String refresh, long refreshExpiresAt) {
    @Override public String toString() { return "Rotated[accessExpiresAt=" + accessExpiresAt + ", refreshExpiresAt=" + refreshExpiresAt + "]"; }
  }

  public record Renewed(String credentialId, String secret, long expiresAt) {
    @Override public String toString() { return "Renewed[credentialId=" + credentialId + ", expiresAt=" + expiresAt + "]"; }
  }

  public sealed interface Answer<T> {
    record Answered<T>(T value) implements Answer<T> {}
    record Refused<T>(int status, String error, Reason reason) implements Answer<T> {
      public boolean retryable() { return status == 408 || status == 429 || status >= 500; }
    }
    record Unanswered<T>() implements Answer<T> {}
  }

  public enum Exchange { SIGNED_IN, REFUSED, UNANSWERED, SUPERSEDED }

  public interface Pause {
    void sleep(long ms) throws InterruptedException;
  }

  private record Reply(int status, String body) {}

  private final URI origin;
  private final DeviceCredentialStore store;
  private final Pause pause;
  private final LongSupplier clock;
  private final Object presenting = new Object();

  public DeviceKeyClient(URI origin, DeviceCredentialStore store, Pause pause) {
    this(origin, store, pause, System::currentTimeMillis);
  }

  public DeviceKeyClient(URI origin, DeviceCredentialStore store, Pause pause, LongSupplier clock) {
    this.origin = origin;
    this.store = store;
    this.pause = pause;
    this.clock = clock;
  }

  public Answer<Grant> connect(String sessionToken, Binding binding, String state, String codeChallenge, String deviceName) {
    StringBuilder body = binding(binding).append(",\"flow\":\"mobile_pkce\",\"state\":").append(CredentialJson.quote(state))
      .append(",\"codeChallenge\":").append(CredentialJson.quote(codeChallenge))
      .append(",\"codeChallengeMethod\":\"").append(CODE_CHALLENGE_METHOD).append('"');
    if (deviceName != null) body.append(",\"deviceName\":").append(CredentialJson.quote(deviceName));
    return ask("POST", CONNECT, sessionToken, body.append('}').toString(), 200,
      answer -> new Grant(CredentialJson.text(answer, "code"), instant(answer, "expiresAt")));
  }

  public Answer<Token> token(Binding binding, Proof proof) {
    String body = binding(binding).append(",\"grantType\":\"authorization_code\",\"code\":").append(CredentialJson.quote(proof.code()))
      .append(",\"state\":").append(CredentialJson.quote(proof.state())).append(",\"codeVerifier\":").append(CredentialJson.quote(proof.verifier()))
      .append('}').toString();
    return ask("POST", TOKEN, null, body, 200, this::token);
  }

  public Token minted(String answer) {
    try {
      return token(CredentialJson.object(CredentialJson.parse(answer), "answer"));
    } catch (IllegalArgumentException unreadable) {
      return null;
    }
  }

  private Token token(Map<String, Object> answer) {
    LeaseSecret lease = null;
    if (answer.get("lease") != null) {
      Map<String, Object> offered = CredentialJson.object(answer.get("lease"), "lease");
      lease = new LeaseSecret(secret(offered, "refresh", LEASE_REFRESH), after(offered, "refreshExpiresIn"));
    }
    return new Token(CredentialJson.text(answer, "credentialId"), CredentialJson.text(answer, "secret"),
      new Account(CredentialJson.text(CredentialJson.object(answer.get("user"), "user"), "id"), CredentialJson.text(answer, "organizationId")),
      instant(answer, "expiresAt"), lease);
  }

  private static String secret(Map<String, Object> answer, String key, Pattern shape) {
    String value = CredentialJson.text(answer, key);
    if (!shape.matcher(value).matches()) throw new CredentialJson.Malformed(key);
    return value;
  }

  private long after(Map<String, Object> answer, String key) {
    long seconds = CredentialJson.whole(answer, key);
    if (seconds <= 0 || seconds > Integer.MAX_VALUE) throw new CredentialJson.Malformed(key);
    return clock.getAsLong() + seconds * 1000L;
  }

  private <T> Answer<T> presentLease(String method, String path, String body, Reading<T> reading, int expectedVersion) {
    synchronized (presenting) {
      HeldLease held = store.lease();
      if (held == null || held.version() != expectedVersion)
        return new Answer.Refused<>(401, "authentication_required", Reason.CREDENTIAL_UNKNOWN);
      Answer<T> answer = ask(method, path, held.refresh(), body, 200, reading);
      if (answer instanceof Answer.Refused<T> refused && refused.status() == 401)
        store.leaseRejected(held.version(), CloudRequestPolicy.credentialReasonOf(refused.reason()), LeaseUse.REFRESH_USE);
      return answer;
    }
  }

  public Answer<Rotated> rotateLease(int expectedVersion) {
    return presentLease("POST", LEASE, "{}", answer -> new Rotated(secret(answer, "access", LEASE_ACCESS), after(answer, "accessExpiresIn"),
      secret(answer, "refresh", LEASE_REFRESH), after(answer, "refreshExpiresIn")), expectedVersion);
  }

  public Exchange renew() {
    Pending unacknowledged = store.pendingRenewal();
    if (unacknowledged != null) return acknowledge(unacknowledged);
    var renewal = store.beginRenewal();
    if (renewal == null) return Exchange.SUPERSEDED;
    int attempt = renewal.attempt();
    Answer<Renewed> answer = presentLease("POST", RENEW, "{}",
      body -> new Renewed(CredentialJson.text(body, "credentialId"), CredentialJson.text(body, "secret"), after(body, "expiresIn")),
      renewal.version());
    if (!(answer instanceof Answer.Answered<Renewed> renewed)) return end(attempt);
    Kept kept = store.tokenAnswered(attempt,
      new Token(renewed.value().credentialId(), renewed.value().secret(), renewal.account(), renewed.value().expiresAt()));
    if (kept != Kept.KEPT) return end(attempt);
    Pending pending = store.pending();
    return pending == null || pending.attempt() != attempt ? Exchange.SUPERSEDED : acknowledge(pending);
  }

  public void renewIfDue() {
    if (store.renewDue() || store.pendingRenewal() != null) renew();
  }

  public Answer<Acknowledgement> ack(String credentialId, String secret) {
    String body = "{\"credentialId\":" + CredentialJson.quote(credentialId) + ",\"secret\":" + CredentialJson.quote(secret) + "}";
    return ask("POST", ACK, null, body, 200, answer -> {
      if (!"acknowledged".equals(answer.get("status")) || !credentialId.equals(answer.get("credentialId"))) throw new CredentialJson.Malformed("acknowledgement");
      return new Acknowledgement(credentialId, instant(answer, "expiresAt"));
    });
  }

  public boolean revoke(String secret) {
    return revoke(secret, "");
  }

  private boolean revoke(String secret, String successor) {
    return settles(ask("DELETE", REVOKE, secret, successor, null, 200, body -> true));
  }

  public boolean revokeLease(String refresh) {
    return settles(ask("DELETE", LEASE, refresh, null, 200, body -> true));
  }

  private static boolean settles(Answer<Boolean> answer) {
    return answer instanceof Answer.Answered<Boolean> || answer instanceof Answer.Refused<Boolean> r && r.status() == 401;
  }

  public Answer<Account> user(String secret) {
    return ask("GET", USER, secret, null, 200, answer -> {
      Map<String, Object> data = CredentialJson.object(answer.get("data"), "data");
      return new Account(CredentialJson.text(data, "id"), CredentialJson.text(data, "organization_id"));
    });
  }

  public Exchange exchange(int attempt, Binding binding, Proof proof) {
    return exchange(attempt, binding, proof, null);
  }

  public Exchange exchange(int attempt, Binding binding, Proof proof, Token minted) {
    Pending pending = store.pending();
    if (pending == null && minted != null) {
      Kept kept = store.tokenAnswered(attempt, minted);
      if (kept == Kept.REFUSED) return end(attempt);
      if (kept == Kept.KEPT) pending = store.pending();
    }
    for (int ask = 0; pending == null && ask < ASKS; ask++) {
      if (ask > 0 && !rest(ask)) return Exchange.UNANSWERED;
      Answer<Token> answer = token(binding, proof);
      if (answer instanceof Answer.Refused<Token> refused && !refused.retryable()) return end(attempt);
      if (!(answer instanceof Answer.Answered<Token> answered)) continue;
      Kept kept = store.tokenAnswered(attempt, answered.value());
      if (kept == Kept.REFUSED) return end(attempt);
      if (kept == Kept.KEPT) pending = store.pending();
    }
    if (pending == null) return Exchange.UNANSWERED;
    if (pending.attempt() != attempt) return Exchange.SUPERSEDED;
    return acknowledge(pending);
  }

  public void settleDuties() {
    for (Owed owed : store.owed()) {
      for (int ask = 0; ask < owed.tries(); ask++) {
        if (ask > 0 && !rest(ask)) return;
        boolean settled = (owed.lease() == null || revokeLease(owed.lease())) & revoke(owed.value(), owed.successor());
        if (store.revokeAnswered(owed.version(), settled) == Outcome.REFUSED) break;
        if (store.owed().stream().noneMatch(o -> o.version() == owed.version())) break;
      }
    }
  }

  public void verifyAccount() {
    CredentialReader.Credential held = store.current();
    if (held == null) return;
    if (user(held.value()) instanceof Answer.Refused<Account> refused && refused.status() == 401 && refused.reason().credential())
      store.rejected(held.version(), refused.reason(), RejectedOn.ACCOUNT_READ);
  }

  private Exchange acknowledge(Pending pending) {
    for (int ask = 0; ask < ASKS; ask++) {
      if (ask > 0 && !rest(ask)) return Exchange.UNANSWERED;
      if (!store.maySendAcknowledgement(pending)) return Exchange.SUPERSEDED;
      Answer<Acknowledgement> answer = ack(pending.credentialId(), pending.value());
      if (answer instanceof Answer.Answered<Acknowledgement> answered)
        return store.acknowledged(pending.attempt(), pending.credentialId(), answered.value().expiresAt()) == Outcome.ACCEPTED ? Exchange.SIGNED_IN : Exchange.SUPERSEDED;
      if (answer instanceof Answer.Refused<Acknowledgement> refused && !refused.retryable()) return end(pending.attempt());
    }
    return Exchange.UNANSWERED;
  }

  private Exchange end(int attempt) {
    return store.signInEnded(attempt) == Outcome.ACCEPTED ? Exchange.REFUSED : Exchange.SUPERSEDED;
  }

  private boolean rest(int ask) {
    try {
      pause.sleep(BACKOFF_MS << (ask - 1));
      return true;
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return false;
    }
  }

  private static StringBuilder binding(Binding binding) {
    return new StringBuilder("{\"clientId\":").append(CredentialJson.quote(binding.clientId()))
      .append(",\"environment\":").append(CredentialJson.quote(binding.environment()))
      .append(",\"redirectUri\":").append(CredentialJson.quote(binding.redirectUri()));
  }

  private static long instant(Map<String, Object> answer, String key) {
    try {
      return Instant.parse(CredentialJson.text(answer, key)).toEpochMilli();
    } catch (DateTimeParseException bad) {
      throw new CredentialJson.Malformed(key);
    }
  }

  interface Reading<T> {
    T read(Map<String, Object> answer);
  }

  <T> Answer<T> ask(String method, String path, String bearer, String body, int expected, Reading<T> reading) {
    return ask(method, path, bearer, "", body, expected, reading);
  }

  private <T> Answer<T> ask(String method, String path, String bearer, String successor, String body, int expected, Reading<T> reading) {
    Reply reply;
    try {
      reply = send(method, path, bearer, successor, body);
    } catch (IOException unanswered) {
      return new Answer.Unanswered<>();
    }
    if (reply.status() / 100 != expected / 100) return refusal(reply);
    try {
      return new Answer.Answered<>(reading.read(reply.body().isEmpty() ? Map.of() : CredentialJson.object(CredentialJson.parse(reply.body()), "answer")));
    } catch (IllegalArgumentException malformed) {
      return new Answer.Refused<>(reply.status(), "malformed_answer", Reason.NO_REASON);
    }
  }

  private static <T> Answer<T> refusal(Reply reply) {
    try {
      Map<String, Object> body = CredentialJson.object(CredentialJson.parse(reply.body()), "refusal");
      String error = body.get("error") instanceof String e ? e : "";
      Reason reason = body.get("reason") instanceof String r ? Reason.ofWire(r) : Reason.NO_REASON;
      return new Answer.Refused<>(reply.status(), error, reason);
    } catch (IllegalArgumentException unreadable) {
      return new Answer.Refused<>(reply.status(), "", Reason.NO_REASON);
    }
  }

  private Reply send(String method, String path, String bearer, String successor, String body) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) origin.resolve(path).toURL().openConnection();
    connection.setInstanceFollowRedirects(false);
    connection.setUseCaches(false);
    connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
    connection.setReadTimeout(READ_TIMEOUT_MS);
    connection.setRequestMethod(method);
    connection.setRequestProperty("Accept", "application/json");
    if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
    if (!successor.isEmpty()) connection.setRequestProperty(RENEWED_CREDENTIAL, successor);
    try {
      if (body != null) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
      }
      int status = connection.getResponseCode();
      if (status < 100) throw new IOException("no status");
      InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      if (stream == null) return new Reply(status, "");
      try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
        byte[] chunk = new byte[1024];
        for (int count = input.read(chunk); count != -1; count = input.read(chunk)) {
          if (output.size() + count > MAX_BODY_BYTES) throw new IOException("answer too large");
          output.write(chunk, 0, count);
        }
        return new Reply(status, new String(output.toByteArray(), StandardCharsets.UTF_8));
      }
    } finally {
      connection.disconnect();
    }
  }
}
