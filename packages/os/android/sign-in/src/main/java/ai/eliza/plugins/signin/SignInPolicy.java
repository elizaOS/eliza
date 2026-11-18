// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Base64;
import java.util.regex.Pattern;

public final class SignInPolicy {
  private SignInPolicy() {}

  public static final long RESEND_COOLDOWN_MS = 30_000L;
  public static final long MAX_RESEND_WAIT_MS = 86_400_000L;
  public static final long DEFAULT_CODE_LIFETIME_MS = 600_000L;
  public static final long MAX_CODE_LIFETIME_MS = 900_000L;
  public static final long MAX_CHALLENGE_LIFETIME_MS = 600_000L;

  public enum Method {
    EMAIL_CODE("email"), SMS_CODE("sms"), GOOGLE_PICKER("google"), GOOGLE_BROWSER("google");
    public final String wire;
    Method(String wire) { this.wire = wire; }
    public boolean code() { return this == EMAIL_CODE || this == SMS_CODE; }
    public static Method google(GoogleMode mode) { return mode == GoogleMode.BROWSER ? GOOGLE_BROWSER : GOOGLE_PICKER; }
  }

  public enum Purpose { SIGN_IN, REAUTHENTICATE }

  public enum Step {
    IDLE("idle"), STARTING("starting"), CODE_SENT("code-sent"), VERIFYING("verifying"), SECOND_FACTOR("second-factor"),
    EXCHANGING("exchanging"), SIGNED_IN("signed-in"), FAILED("failed");
    public final String wire;
    Step(String wire) { this.wire = wire; }
    public boolean open() { return this != IDLE && this != SIGNED_IN && this != FAILED; }
  }

  public enum Failure {
    CANCELLED("cancelled"), BUSY("busy"), INVALID_REQUEST("invalid-request"), INVALID_CODE("invalid-code"), EXPIRED("expired"),
    TOO_MANY_ATTEMPTS("too-many-attempts"), UNAVAILABLE("unavailable"), REFUSED("refused"),
    GOOGLE_UNAVAILABLE("google-unavailable"), STORAGE("storage");
    public final String wire;
    Failure(String wire) { this.wire = wire; }
  }

  public enum Google {
    NOT_REQUESTED("not-requested"), HELD("held"), CONNECTED("connected"), REFUSED("refused");
    public final String wire;
    Google(String wire) { this.wire = wire; }
  }

  public enum Verify { VERIFIED, FACTOR_REQUIRED, WRONG_CODE, UNANSWERED, LOCKED, EXPIRED, REFUSED, MALFORMED }

  public enum Stage { SEND, VERIFY, EXCHANGE, GOOGLE }

  public record State(int attempt, String request, String resend, Method method, Purpose purpose, Step step, boolean factor,
      Google google, String credentialId, Failure failure) {
    State at(Step next) { return new State(attempt, request, resend, method, purpose, next, factor, google, credentialId, failure); }
    State failed(Failure code) {
      return new State(attempt, request, "", method, purpose, Step.FAILED, factor, google == Google.HELD ? Google.REFUSED : google, "", code);
    }
    State resending(String id) { return new State(attempt, request, id, method, purpose, step, factor, google, credentialId, failure); }
  }

  public static final State INITIAL = new State(0, "", "", Method.EMAIL_CODE, Purpose.SIGN_IN, Step.IDLE, false, Google.NOT_REQUESTED, "", null);

  public sealed interface Event {
    String request();
    record Open(String request, Method method, Purpose purpose) implements Event {}
    record Resend(String request) implements Event {}
    record CodeSent(String request) implements Event {}
    record Submit(String request) implements Event {}
    record VerifyAnswered(String request, Verify answer) implements Event {}
    record ProofReady(String request, Google google) implements Event {}
    record FactorRequired(String request) implements Event {}
    record Acknowledged(String request, String credentialId) implements Event {}
    record GoogleSettled(String request, boolean connected) implements Event {}
    record Fail(String request, Failure failure) implements Event {}
    record Cancel(String request) implements Event {}
  }

  public record Receipt(String requestId, String attemptId, String credentialId, Google google, Failure failure) {}

  public static boolean admitted(Method method, Purpose purpose, GoogleMode registered) {
    if (method == Method.GOOGLE_PICKER) return purpose == Purpose.SIGN_IN && registered == GoogleMode.PICKER;
    return method != Method.GOOGLE_BROWSER || registered == GoogleMode.BROWSER || purpose == Purpose.REAUTHENTICATE;
  }

  private static boolean owns(State s, String request) { return !request.isEmpty() && request.equals(s.request) && s.step.open(); }

  public static boolean enabled(State s, Event event) {
    String id = event.request();
    if (event instanceof Event.Open open) {
      return !id.isEmpty() && !s.step.open() && (open.method() != Method.GOOGLE_PICKER || open.purpose() == Purpose.SIGN_IN);
    }
    if (event instanceof Event.Resend) {
      return !id.isEmpty() && s.step == Step.CODE_SENT && s.method.code() && s.resend.isEmpty() && !id.equals(s.request);
    }
    if (event instanceof Event.CodeSent) {
      return s.method.code() && ((owns(s, id) && s.step == Step.STARTING) || (!id.isEmpty() && id.equals(s.resend) && s.step == Step.CODE_SENT));
    }
    if (event instanceof Event.Submit) {
      return owns(s, id) && s.resend.isEmpty() && (s.step == Step.CODE_SENT || s.step == Step.SECOND_FACTOR);
    }
    if (event instanceof Event.VerifyAnswered) return owns(s, id) && s.step == Step.VERIFYING;
    if (event instanceof Event.ProofReady proof) {
      boolean google = s.method == Method.GOOGLE_PICKER || s.method == Method.GOOGLE_BROWSER;
      boolean custody = proof.google() == Google.NOT_REQUESTED
        || ((proof.google() == Google.HELD || proof.google() == Google.REFUSED) && s.method == Method.GOOGLE_PICKER);
      return owns(s, id) && s.step == Step.STARTING && google && custody;
    }
    if (event instanceof Event.FactorRequired) return owns(s, id) && s.step == Step.EXCHANGING && !s.factor && s.credentialId.isEmpty();
    if (event instanceof Event.Acknowledged ack) return owns(s, id) && s.step == Step.EXCHANGING && s.credentialId.isEmpty() && !ack.credentialId().isEmpty();
    if (event instanceof Event.GoogleSettled) {
      return owns(s, id) && s.step == Step.EXCHANGING && s.google == Google.HELD && (!s.factor || !s.credentialId.isEmpty());
    }
    if (event instanceof Event.Fail) return owns(s, id) || (!id.isEmpty() && id.equals(s.resend));
    if (event instanceof Event.Cancel) return owns(s, id) || (!id.isEmpty() && id.equals(s.resend));
    return false;
  }

  public static State step(State s, Event event) {
    if (!enabled(s, event)) return s;
    String id = event.request();
    if (event instanceof Event.Open open) {
      return new State(s.attempt + 1, id, "", open.method(), open.purpose(), Step.STARTING, false, Google.NOT_REQUESTED, "", null);
    }
    if (event instanceof Event.Resend) return s.resending(id);
    if (event instanceof Event.CodeSent) {
      return id.equals(s.resend)
        ? new State(s.attempt + 1, id, "", s.method, s.purpose, Step.CODE_SENT, false, s.google, "", null)
        : s.at(Step.CODE_SENT);
    }
    if (event instanceof Event.Submit) return s.at(Step.VERIFYING);
    if (event instanceof Event.VerifyAnswered answered) {
      Step kept = s.factor ? Step.SECOND_FACTOR : Step.CODE_SENT;
      return switch (answered.answer()) {
        case VERIFIED -> s.at(Step.EXCHANGING);
        case FACTOR_REQUIRED -> s.factor ? s.failed(Failure.UNAVAILABLE)
          : new State(s.attempt, s.request, "", s.method, s.purpose, Step.SECOND_FACTOR, true, s.google, "", null);
        case WRONG_CODE, UNANSWERED -> s.at(kept);
        case LOCKED -> s.failed(Failure.TOO_MANY_ATTEMPTS);
        case EXPIRED -> s.failed(Failure.EXPIRED);
        case REFUSED -> s.failed(Failure.REFUSED);
        case MALFORMED -> s.failed(Failure.UNAVAILABLE);
      };
    }
    if (event instanceof Event.ProofReady proof) {
      return new State(s.attempt, s.request, "", s.method, s.purpose, Step.EXCHANGING, false, proof.google(), "", null);
    }
    if (event instanceof Event.FactorRequired) {
      return new State(s.attempt, s.request, "", s.method, s.purpose, Step.SECOND_FACTOR, true, s.google, "", null);
    }
    if (event instanceof Event.Acknowledged ack) {
      return new State(s.attempt, s.request, "", s.method, s.purpose, s.google == Google.HELD ? Step.EXCHANGING : Step.SIGNED_IN,
        s.factor, s.google, ack.credentialId(), null);
    }
    if (event instanceof Event.GoogleSettled settled) {
      return new State(s.attempt, s.request, "", s.method, s.purpose, s.credentialId.isEmpty() ? Step.EXCHANGING : Step.SIGNED_IN,
        s.factor, settled.connected() ? Google.CONNECTED : Google.REFUSED, s.credentialId, null);
    }
    if (id.equals(s.resend)) return s.resending("");
    if (!s.credentialId.isEmpty()) {
      return new State(s.attempt, s.request, "", s.method, s.purpose, Step.SIGNED_IN, s.factor, Google.REFUSED, s.credentialId, null);
    }
    return s.failed(event instanceof Event.Fail fail ? fail.failure() : Failure.CANCELLED);
  }

  public static boolean invariant(State s) {
    boolean ids = s.attempt >= 0 && (s.step == Step.IDLE) == (s.attempt == 0) && (s.step == Step.IDLE) == s.request.isEmpty();
    boolean failure = (s.step == Step.FAILED) == (s.failure != null);
    boolean resend = s.resend.isEmpty() || (s.step == Step.CODE_SENT && !s.resend.equals(s.request));
    boolean key = s.credentialId.isEmpty() ? s.step != Step.SIGNED_IN : (s.step == Step.SIGNED_IN || s.step == Step.EXCHANGING);
    boolean google = (s.step != Step.SIGNED_IN && s.step != Step.FAILED) || s.google != Google.HELD;
    boolean custody = s.google == Google.NOT_REQUESTED || s.method == Method.GOOGLE_PICKER;
    boolean factor = s.step != Step.SECOND_FACTOR || s.factor;
    boolean picker = s.method != Method.GOOGLE_PICKER || s.purpose == Purpose.SIGN_IN;
    return ids && failure && resend && key && google && custody && factor && picker;
  }

  public static Verify verifyAnswer(int status, String statusField, String error, String reason) {
    if (status == 200) {
      return "signed_in".equals(statusField) ? Verify.VERIFIED : "mfa_required".equals(statusField) ? Verify.FACTOR_REQUIRED : Verify.MALFORMED;
    }
    Failure failure = failureFor(Stage.VERIFY, status, error, reason);
    return switch (failure) {
      case INVALID_CODE -> Verify.WRONG_CODE;
      case UNAVAILABLE -> Verify.UNANSWERED;
      case TOO_MANY_ATTEMPTS -> Verify.LOCKED;
      case EXPIRED -> Verify.EXPIRED;
      default -> Verify.REFUSED;
    };
  }

  public static Failure failureFor(Stage stage, int status, String error, String reason) {
    if (status == 429 || "rate_limited".equals(error)) return Failure.TOO_MANY_ATTEMPTS;
    if (status == 403 && "access_denied".equals(error) && "challenge_locked".equals(reason)) return Failure.TOO_MANY_ATTEMPTS;
    if (status < 200 || status == 408 || status >= 500) {
      return stage == Stage.GOOGLE && "google_not_configured".equals(error) ? Failure.GOOGLE_UNAVAILABLE : Failure.UNAVAILABLE;
    }
    if (status == 410 || (reason != null && reason.endsWith("_expired")) || "credential_proof_invalid".equals(error)) return Failure.EXPIRED;
    if (status == 403 || status == 404) return Failure.REFUSED;
    if (status == 400 || status == 401) {
      return switch (stage) {
        case VERIFY -> "invalid_request".equals(error) || "invalid_client".equals(error) || "redirect_mismatch".equals(error)
          ? Failure.REFUSED : Failure.INVALID_CODE;
        case EXCHANGE -> Failure.EXPIRED;
        case SEND -> Failure.INVALID_REQUEST;
        case GOOGLE -> status == 400 ? Failure.INVALID_REQUEST : Failure.REFUSED;
      };
    }
    return Failure.REFUSED;
  }

  public static boolean clientRefused(String error) {
    return "invalid_client".equals(error) || "client_disabled".equals(error) || "redirect_mismatch".equals(error);
  }

  private static final Pattern EMAIL = Pattern.compile("[^\\s@\\p{Cc}\\p{Cf}]+@[^\\s@\\p{Cc}\\p{Cf}]+\\.[^\\s@\\p{Cc}\\p{Cf}]+");
  private static final Pattern PHONE = Pattern.compile("\\+[1-9][0-9]{6,14}");
  private static final Pattern CODE = Pattern.compile("[0-9]{6}");
  private static final Pattern UUID = Pattern.compile("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  private static final Pattern VERIFIER = Pattern.compile("[A-Za-z0-9._~-]{43,128}");
  private static final Pattern STATE = Pattern.compile("[A-Za-z0-9_-]{43}");
  private static final Pattern NONCE = Pattern.compile("[A-Za-z0-9_-]{32,256}");
  private static final Pattern SERVER_CLIENT_ID = Pattern.compile("[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com");
  private static final Pattern SERVER_CODE = Pattern.compile("[A-Za-z0-9/_.~-]{10,2048}");
  private static final Pattern ID_TOKEN = Pattern.compile("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+");
  private static final Pattern BEARER = Pattern.compile("[\\x21-\\x7e]{20,16384}");

  public static boolean validEmail(String value) { return value != null && value.length() <= 320 && EMAIL.matcher(value).matches(); }
  public static boolean validPhone(String value) { return value != null && PHONE.matcher(value).matches(); }
  public static boolean validCode(String value) { return value != null && CODE.matcher(value).matches(); }
  public static boolean validUuid(String value) { return value != null && UUID.matcher(value).matches(); }
  public static boolean validVerifier(String value) { return value != null && VERIFIER.matcher(value).matches(); }
  public static boolean validState(String value) { return value != null && STATE.matcher(value).matches(); }
  public static boolean validNonce(String value) { return value != null && NONCE.matcher(value).matches(); }
  public static boolean validServerClientId(String value) { return value != null && SERVER_CLIENT_ID.matcher(value).matches(); }
  public static boolean validServerCode(String value) { return value != null && SERVER_CODE.matcher(value).matches(); }
  public static boolean validIdToken(String value) { return value != null && value.length() <= 7500 && ID_TOKEN.matcher(value).matches(); }
  public static boolean validBearer(String value) { return value != null && BEARER.matcher(value).matches(); }
  public static boolean validDestination(Method method, String value) {
    return method == Method.EMAIL_CODE ? validEmail(value) : method == Method.SMS_CODE && validPhone(value);
  }

  private static final SecureRandom RANDOM = new SecureRandom();

  private static String random(int bytes) {
    byte[] value = new byte[bytes];
    RANDOM.nextBytes(value);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  public static String newVerifier() { return random(48); }
  public static String newState() { return random(32); }

  public static String s256(String verifier) {
    try {
      return Base64.getUrlEncoder().withoutPadding()
        .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
    } catch (NoSuchAlgorithmException missing) {
      throw new IllegalStateException(missing);
    }
  }

  public static long instant(Object reported) {
    if (reported instanceof Number number) return number.longValue();
    if (reported instanceof String text) {
      try { return Instant.parse(text).toEpochMilli(); } catch (DateTimeParseException invalid) { return 0; }
    }
    return 0;
  }

  private static long httpDate(String value) {
    try { return ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli(); }
    catch (DateTimeParseException invalid) { return 0; }
  }

  public static long codeExpiresAt(Object reported, long now) {
    long value = instant(reported);
    return value <= 0 ? now + DEFAULT_CODE_LIFETIME_MS : Math.min(value, now + MAX_CODE_LIFETIME_MS);
  }

  public static long challengeExpiresAt(Object expiresAt, Object expiresInSeconds, long now) {
    long value = instant(expiresAt);
    if (value <= 0 && expiresInSeconds instanceof Number seconds && seconds.longValue() > 0) value = now + seconds.longValue() * 1000L;
    return value <= now ? 0 : Math.min(value, now + MAX_CHALLENGE_LIFETIME_MS);
  }

  public static long resendAt(Object reported, String retryAfter, long now) {
    long result = Math.max(now + RESEND_COOLDOWN_MS, instant(reported));
    if (retryAfter != null) {
      String value = retryAfter.trim();
      result = Math.max(result, value.matches("[0-9]{1,9}") ? now + Long.parseLong(value) * 1000L : httpDate(value));
    }
    return Math.min(result, now + MAX_RESEND_WAIT_MS);
  }
}
