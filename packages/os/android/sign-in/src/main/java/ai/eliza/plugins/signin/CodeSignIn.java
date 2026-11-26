// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Session;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInPolicy.Method;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class CodeSignIn {
  public static final String EMAIL_SEND = "/api/v1/auth/email/code/send";
  public static final String EMAIL_VERIFY = "/api/v1/auth/email/code/verify";
  public static final String SMS_SEND = "/api/v1/auth/sms/code/send";
  public static final String SMS_VERIFY = "/api/v1/auth/sms/code/verify";
  public static final String FACTOR_COMPLETE = "/api/v1/auth/mfa/complete";
  public static final String FACTOR_SMS_SEND = "/api/v1/auth/mfa/sms/send";
  public static final String LOGOUT = "/api/v1/auth/logout";
  public static final List<String> FACTORS = List.of("totp", "sms");
  private static final int MAX_BODY = 65_536;
  private static final int CONNECT_TIMEOUT_MS = 10_000;
  private static final int READ_TIMEOUT_MS = 20_000;

  public record Answer(int status, JSONObject body, String retryAfter) {
    public String error() { return body.optString("error", ""); }
    public String reason() { return body.optString("reason", ""); }
    public boolean ok() { return status == 200 || status == 201 || status == 202; }
  }

  public interface Http {
    Answer send(String method, String url, String body, String bearer) throws IOException;

    default Answer post(String url, JSONObject body, String bearer) throws IOException { return send("POST", url, body.toString(), bearer); }
  }

  public static final Http CONNECTION = (method, url, body, bearer) -> {
    HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
    try {
      connection.setRequestMethod(method);
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setInstanceFollowRedirects(false);
      connection.setUseCaches(false);
      connection.setRequestProperty("Accept", "application/json");
      if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
      if (body != null) {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
      }
      int status = connection.getResponseCode();
      InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
      return new Answer(status, object(read(in)), connection.getHeaderField("Retry-After"));
    } finally {
      connection.disconnect();
    }
  };

  public sealed interface Checked {
    record SessionIssued(Session session) implements Checked {}
    record KeyMinted(Proof proof, Account account, long keyExpiresAt, boolean googleConnected) implements Checked {
      boolean belongsTo(Account expected) { return account.equals(expected); }
    }
    record FactorAsked(String challengeId, List<String> factors, long expiresAt) implements Checked {}
    record NotChecked(CloudReply reply) implements Checked {}
  }

  public record Sent(CloudReply reply, long expiresAt, long resendAt) {}

  private final Http http;
  private final String clientId;

  public CodeSignIn(Http http, String clientId) { this.http = http; this.clientId = clientId; }

  public Sent send(SignInRegistration.Environment environment, Method method, String destination, String verifier, long now) {
    JSONObject body = json(destinationKey(method), destination, "clientId", clientId,
      "codeChallenge", SignInPolicy.s256(verifier), "codeChallengeMethod", "S256");
    Answer sent;
    try { sent = http.post(environment.apiOrigin + (method == Method.SMS_CODE ? SMS_SEND : EMAIL_SEND), body, null); }
    catch (IOException | RuntimeException unanswered) { return new Sent(new CloudReply.Unanswered(), 0, 0); }
    long resendAt = SignInPolicy.resendAt(sent.body.opt("retryAt"), sent.retryAfter, now);
    if (!sent.ok()) return new Sent(refusal(sent), 0, resendAt);
    return new Sent(new CloudReply.Delivered(), SignInPolicy.codeExpiresAt(sent.body.opt("expiresAt"), now), resendAt);
  }

  public Checked verify(SignInRegistration.Environment environment, Method method, String destination, String code, String verifier, long now) {
    return checked(environment.apiOrigin + (method == Method.SMS_CODE ? SMS_VERIFY : EMAIL_VERIFY),
      json(destinationKey(method), destination, "code", code, "clientId", clientId, "codeVerifier", verifier), now);
  }

  public Checked completeFactor(SignInRegistration.Environment environment, String challengeId, String factor, String code, long now) {
    return checked(environment.apiOrigin + FACTOR_COMPLETE, json("challengeId", challengeId, "method", factor, "code", code), now);
  }

  public CloudReply sendFactorCode(SignInRegistration.Environment environment, String challengeId) {
    Answer sent;
    try { sent = http.post(environment.apiOrigin + FACTOR_SMS_SEND, json("challengeId", challengeId), null); }
    catch (IOException | RuntimeException unanswered) { return new CloudReply.Unanswered(); }
    return sent.ok() ? new CloudReply.Delivered() : refusal(sent);
  }

  public void logout(SignInRegistration.Environment environment, Session session) {
    try { http.post(environment.apiOrigin + LOGOUT, json("refreshToken", session.refreshToken()), session.accessToken()); }
    catch (IOException | RuntimeException ended) { return; }
  }

  private Checked checked(String url, JSONObject body, long now) {
    Answer answer;
    try { answer = http.post(url, body, null); }
    catch (IOException | RuntimeException unanswered) { return new Checked.NotChecked(new CloudReply.Unanswered()); }
    return checked(answer, now);
  }

  public static CloudReply refusal(Answer answer) { return SignInPolicy.refusal(answer.status, answer.error(), answer.reason()); }

  public static Checked checked(Answer answer, long now) {
    if (!answer.ok()) return new Checked.NotChecked(refusal(answer));
    String status = answer.body.optString("status", "");
    if (status.equals("mfa_required")) {
      String challengeId = answer.body.optString("challengeId", "");
      long expiresAt = SignInPolicy.challengeExpiresAt(answer.body.opt("expiresAt"), now);
      List<String> factors = factors(answer.body.optJSONArray("methods"));
      return challengeId.isEmpty() || challengeId.length() > 256 || expiresAt == 0 || factors.isEmpty()
        ? new Checked.NotChecked(new CloudReply.Unanswered()) : new Checked.FactorAsked(challengeId, factors, expiresAt);
    }
    Session session = status.equals("signed_in") ? session(answer.body, now) : null;
    return session == null ? new Checked.NotChecked(new CloudReply.Unanswered()) : new Checked.SessionIssued(session);
  }

  static Checked checkedGoogle(Answer answer, String state, String verifier, long now) {
    if (!answer.ok() || !"signed_in".equals(answer.body.optString("status"))) return checked(answer, now);
    JSONObject body = answer.body, google = body.optJSONObject("google");
    String code = body.optString("code", "");
    Account owner = account(body);
    long keyExpiresAt = SignInPolicy.instant(body.opt("expiresAt"));
    if (code.isEmpty() || owner == null || keyExpiresAt <= now) return new Checked.NotChecked(new CloudReply.Unanswered());
    return new Checked.KeyMinted(new Proof(code, state, verifier), owner, keyExpiresAt, google != null && google.optBoolean("connected", false));
  }

  private static Account account(JSONObject body) {
    JSONObject user = body.optJSONObject("user");
    if (user == null || !(user.opt("id") instanceof String userId) || userId.isEmpty() || userId.length() > 256
        || !(body.opt("organizationId") instanceof String organizationId) || organizationId.isEmpty() || organizationId.length() > 256) return null;
    return new Account(userId, organizationId);
  }

  public static Session session(JSONObject body, long now) {
    Account owner = account(body);
    String access = body.optString("accessToken", ""), refresh = body.optString("refreshToken", "");
    long accessExpiresAt = SignInPolicy.instant(body.opt("accessExpiresAt"));
    if (owner == null || !SignInPolicy.validBearer(access) || !SignInPolicy.validBearer(refresh) || accessExpiresAt <= now) return null;
    return new Session(owner, access, refresh, accessExpiresAt);
  }

  private static List<String> factors(JSONArray methods) {
    List<String> found = new ArrayList<>();
    for (int i = 0; methods != null && i < methods.length(); i++) {
      String method = methods.optString(i, "");
      if (FACTORS.contains(method) && !found.contains(method)) found.add(method);
    }
    return found;
  }

  private static String destinationKey(Method method) { return method == Method.SMS_CODE ? "phone" : "email"; }

  static JSONObject json(Object... pairs) {
    JSONObject object = new JSONObject();
    try {
      for (int i = 0; i < pairs.length; i += 2) object.put((String) pairs[i], pairs[i + 1]);
    } catch (JSONException invalid) {
      throw new IllegalArgumentException(invalid);
    }
    return object;
  }

  static JSONObject object(String text) {
    try { return text == null || text.isEmpty() ? new JSONObject() : new JSONObject(text); }
    catch (JSONException malformed) { return new JSONObject(); }
  }

  private static String read(InputStream in) throws IOException {
    if (in == null) return "";
    try (InputStream source = in) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      for (int n = source.read(buffer); n >= 0; n = source.read(buffer)) {
        if (out.size() + n > MAX_BODY) throw new IOException("answer too large");
        out.write(buffer, 0, n);
      }
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }
}
