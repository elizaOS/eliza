// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.ReadinessPolicy.DeviceFacts;
import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import ai.eliza.plugins.signin.ReadinessPolicy.Readiness;
import ai.eliza.plugins.signin.ReadinessPolicy.SignInMethod;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

public final class SignInPolicy {
  private SignInPolicy() {}

  public enum Environment { PRODUCTION, STAGING }

  public enum BuildKind { RELEASE_BUILD, DEBUG_BUILD }

  public record Registration(boolean complete, boolean googleScopes, boolean testEnvironments) {}

  public enum PluginTag { NOT_LOADED, LOADED, REGISTRATION_REFUSED }

  public record Plugin(PluginTag tag, boolean googleScopes, boolean testEnvironments) {
    public static final Plugin NOT_LOADED = new Plugin(PluginTag.NOT_LOADED, false, false);
    public static final Plugin REGISTRATION_REFUSED = new Plugin(PluginTag.REGISTRATION_REFUSED, false, false);
    public static Plugin loaded(boolean googleScopes, boolean testEnvironments) { return new Plugin(PluginTag.LOADED, googleScopes, testEnvironments); }
  }

  public enum Method {
    EMAIL_CODE, SMS_CODE, GOOGLE_PICKER, GOOGLE_BROWSER;
    public boolean code() { return this == EMAIL_CODE || this == SMS_CODE; }
    public SignInMethod readiness() {
      return switch (this) {
        case EMAIL_CODE -> SignInMethod.EMAIL_CODE;
        case SMS_CODE -> SignInMethod.SMS_CODE;
        case GOOGLE_PICKER -> SignInMethod.google(GoogleMode.PICKER);
        case GOOGLE_BROWSER -> SignInMethod.google(GoogleMode.BROWSER);
      };
    }
    public static Method google(GoogleMode mode) { return mode == GoogleMode.BROWSER ? GOOGLE_BROWSER : GOOGLE_PICKER; }
  }

  public record Purpose(Account account) {
    public static final Purpose SIGN_IN = new Purpose(null);
    public static Purpose reauthenticate(Account account) { return new Purpose(account); }
    public boolean reauthenticating() { return account != null; }
  }

  public enum Stage { CODE_STAGE, FACTOR_STAGE, GOOGLE_STAGE }

  public enum Failure {
    CANCELLED("cancelled"), BUSY("busy"), INVALID_INPUT("invalid-input"), WRONG_CODE("wrong-code"), EXPIRED("expired"),
    TOO_MANY_ATTEMPTS("too-many-attempts"), UNAVAILABLE("unavailable"), GOOGLE_UNAVAILABLE("google-unavailable"),
    WRONG_ACCOUNT("wrong-account"), REJECTED("rejected");
    public final String wire;
    Failure(String wire) { this.wire = wire; }
  }

  public enum PhaseTag { IDLE, SENDING, CODE_SENT, PICKING, VERIFYING, SECOND_FACTOR, EXCHANGING, CONNECTING, SIGNED_IN, REAUTHENTICATED, FAILED }

  public record Phase(PhaseTag tag, int fallback, Stage stage, int credentialAttempt, Failure failure) {
    public static final Phase IDLE = of(PhaseTag.IDLE);
    public static final Phase CODE_SENT = of(PhaseTag.CODE_SENT);
    public static final Phase PICKING = of(PhaseTag.PICKING);
    public static final Phase SECOND_FACTOR = of(PhaseTag.SECOND_FACTOR);
    public static final Phase CONNECTING = of(PhaseTag.CONNECTING);
    public static final Phase SIGNED_IN = of(PhaseTag.SIGNED_IN);
    public static final Phase REAUTHENTICATED = of(PhaseTag.REAUTHENTICATED);
    private static Phase of(PhaseTag tag) { return new Phase(tag, 0, null, 0, null); }
    public static Phase sending(int fallback) { return new Phase(PhaseTag.SENDING, fallback, null, 0, null); }
    public static Phase verifying(Stage stage) { return new Phase(PhaseTag.VERIFYING, 0, stage, 0, null); }
    public static Phase exchanging(int credentialAttempt) { return new Phase(PhaseTag.EXCHANGING, 0, null, credentialAttempt, null); }
    public static Phase failed(Failure failure) { return new Phase(PhaseTag.FAILED, 0, null, 0, failure); }
  }

  public enum ServerCode { NO_SERVER_CODE, HELD_CODE, SPENT_CODE, DROPPED_CODE }

  public enum GoogleReport {
    GOOGLE_NOT_REQUESTED("not-requested"), GOOGLE_CONNECTED("connected"), GOOGLE_REFUSED("refused");
    public final String wire;
    GoogleReport(String wire) { this.wire = wire; }
  }

  public record State(Plugin plugin, int lastRequest, int open, int lastAttempt, int attempt, Environment environment, Method method,
      Purpose purpose, Phase phase, ServerCode serverCode, GoogleReport google, String credentialId) {
    State at(Phase next, int nextOpen) {
      return new State(plugin, lastRequest, nextOpen, lastAttempt, attempt, environment, method, purpose, next, serverCode, google, credentialId);
    }
  }

  public static final State INITIAL = new State(Plugin.NOT_LOADED, 0, 0, 0, 0, Environment.PRODUCTION, Method.EMAIL_CODE, Purpose.SIGN_IN,
    Phase.IDLE, ServerCode.NO_SERVER_CODE, GoogleReport.GOOGLE_NOT_REQUESTED, "");

  public enum VerdictTag { CODE_ON_ITS_WAY, FACTOR_ASKED, SIGNED_IN_AS, ACCOUNT_CONFIRMED, TRY_AGAIN, ENDED }

  public record Verdict(VerdictTag tag, String credentialId, GoogleReport google, Failure failure) {
    static Verdict of(VerdictTag tag) { return new Verdict(tag, null, null, null); }
    static Verdict signedInAs(String credentialId, GoogleReport google) { return new Verdict(VerdictTag.SIGNED_IN_AS, credentialId, google, null); }
    static Verdict tryAgain(Failure retry) { return new Verdict(VerdictTag.TRY_AGAIN, null, null, retry); }
    static Verdict ended(Failure problem) { return new Verdict(VerdictTag.ENDED, null, null, problem); }
  }

  public sealed interface Effect {
    record Settled(int request, int attempt, Verdict verdict) implements Effect {}
    record ConnectGoogle() implements Effect {}
    record AbandonExchange(int abandoned) implements Effect {}
    record HandSession(Account account, long accessExpiresAt) implements Effect {}
  }

  public record Step(State state, List<Effect> out) {}

  public enum RefusalCode {
    INVALID_REQUEST("InvalidRequest", 400), MODEL_UNAVAILABLE("ModelUnavailable", 400), INVALID_CLIENT("InvalidClient", 400),
    REDIRECT_MISMATCH("RedirectMismatch", 400), GRANT_CODE_INVALID("GrantCodeInvalid", 400),
    AUTHENTICATION_REQUIRED("AuthenticationRequired", 401), CREDENTIAL_PROOF_INVALID("CredentialProofInvalid", 401),
    INSUFFICIENT_CREDITS("InsufficientCredits", 402), ALLOWANCE_EXHAUSTED("AllowanceExhausted", 402),
    ACCESS_DENIED("AccessDenied", 403), CLIENT_DISABLED("ClientDisabled", 403), SPEECH_CONSENT_REQUIRED("SpeechConsentRequired", 403),
    NOT_FOUND("NotFound", 404), CAPABILITY_UNAVAILABLE("CapabilityUnavailable", 404),
    IDEMPOTENCY_CONFLICT("IdempotencyConflict", 409), STALE_REVISION("StaleRevision", 409), BILLING_STATE_CONFLICT("BillingStateConflict", 409),
    IDENTITY_IN_USE("IdentityInUse", 409), LAST_METHOD("LastMethod", 409), GOOGLE_REAUTH_REQUIRED("GoogleReauthRequired", 409),
    SUBSCRIPTION_GRANT_ALREADY_REDEEMED("SubscriptionGrantAlreadyRedeemed", 409), SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE("SubscriptionGrantPaidPlanActive", 409),
    REFERRAL_ALREADY_APPLIED("ReferralAlreadyApplied", 409), SESSION_CLOSED("SessionClosed", 410), PRECONDITION_FAILED("PreconditionFailed", 412),
    CONTENT_TOO_LARGE("ContentTooLarge", 413), NO_ROUTE("NoRoute", 422), UNSUPPORTED_MODE("UnsupportedMode", 422),
    UNSUPPORTED_REGION("UnsupportedRegion", 422), FRESH_SESSION_REQUIRED("FreshSessionRequired", 428), RATE_LIMITED("RateLimited", 429),
    PROVIDER_INVALID_RESPONSE("ProviderInvalidResponse", 502), SERVICE_UNAVAILABLE("ServiceUnavailable", 503),
    PROVIDER_UNAVAILABLE("ProviderUnavailable", 503), RATE_LIMIT_UNAVAILABLE("RateLimitUnavailable", 503);
    public final String tag;
    public final int status;
    RefusalCode(String tag, int status) { this.tag = tag; this.status = status; }
    public boolean retryable() { return status == 429 || status == 503; }
    public String wire() { return tag.replaceAll("(?<=[a-z0-9])(?=[A-Z])", "_").toLowerCase(Locale.ROOT); }
    public static RefusalCode ofTag(String tag) {
      for (RefusalCode code : values()) if (code.tag.equals(tag)) return code;
      throw new IllegalArgumentException("refusal code " + tag);
    }
    public static RefusalCode ofWire(String wire) {
      for (RefusalCode code : values()) if (code.wire().equals(wire)) return code;
      return null;
    }
  }

  public sealed interface CloudReply {
    record Delivered() implements CloudReply {}
    record Authenticated(String userId, int credentialAttempt, long accessExpiresAt, GoogleReport google) implements CloudReply {}
    record FactorRequired() implements CloudReply {}
    record Refused(RefusalCode code, Reason reason) implements CloudReply {}
    record Unanswered() implements CloudReply {}
  }

  public enum KeyTag { KEY_ACKNOWLEDGED, KEY_REFUSED }

  public record KeyOutcome(KeyTag tag, String credentialId) {
    public static final KeyOutcome REFUSED = new KeyOutcome(KeyTag.KEY_REFUSED, null);
    public static KeyOutcome acknowledged(String credentialId) { return new KeyOutcome(KeyTag.KEY_ACKNOWLEDGED, credentialId); }
  }

  public enum PickerTag { PICKED, PICKER_DISMISSED, NO_GOOGLE_ACCOUNT }

  public record PickerResult(PickerTag tag, boolean granted) {
    public static final PickerResult DISMISSED = new PickerResult(PickerTag.PICKER_DISMISSED, false);
    public static final PickerResult NO_GOOGLE_ACCOUNT = new PickerResult(PickerTag.NO_GOOGLE_ACCOUNT, false);
    public static PickerResult picked(boolean granted) { return new PickerResult(PickerTag.PICKED, granted); }
  }

  public sealed interface Event {
    record Load(Registration registration, BuildKind build) implements Event {}
    record Start(Environment environment, Method method, Readiness readiness, DeviceFacts device) implements Event {}
    record Unchanged() implements Event {}
    record Verify(int attempt) implements Event {}
    record CloudAnswered(int attempt, CloudReply reply) implements Event {}
    record ExchangeSettled(int credentialAttempt, KeyOutcome key) implements Event {}
    record PickerAnswered(int attempt, PickerResult picked) implements Event {}
    record GoogleConnected(int attempt, boolean connected) implements Event {}
    record Resend(int attempt) implements Event {}
    record Cancel(int attempt) implements Event {}
    record Expire(int attempt) implements Event {}
    record Reauthenticate(Environment environment, Method method, Readiness readiness, DeviceFacts device, Account account) implements Event {}
  }

  public static boolean isLoaded(Plugin p) { return p.tag() == PluginTag.LOADED; }
  public static boolean admits(Plugin p, Environment environment) { return isLoaded(p) && (environment == Environment.PRODUCTION || p.testEnvironments()); }
  public static boolean scopesRegistered(Plugin p) { return isLoaded(p) && p.googleScopes(); }

  public static boolean isBusy(Phase phase) {
    return switch (phase.tag()) {
      case SENDING, PICKING, VERIFYING, EXCHANGING, CONNECTING -> true;
      default -> false;
    };
  }

  public static int fallbackOf(Phase phase) { return phase.tag() == PhaseTag.SENDING ? phase.fallback() : 0; }

  private static Phase firstStep(Method method) {
    return switch (method) {
      case GOOGLE_PICKER -> Phase.PICKING;
      case GOOGLE_BROWSER -> Phase.verifying(Stage.GOOGLE_STAGE);
      case EMAIL_CODE, SMS_CODE -> Phase.sending(0);
    };
  }

  private static State opened(Environment environment, Method method, Purpose purpose, State s) {
    return new State(s.plugin(), s.lastRequest() + 1, s.lastRequest() + 1, s.lastAttempt() + 1, s.lastAttempt() + 1, environment, method, purpose,
      firstStep(method), ServerCode.NO_SERVER_CODE, GoogleReport.GOOGLE_NOT_REQUESTED, "");
  }

  public static boolean canStart(State s, Environment environment, Method method, Readiness readiness, DeviceFacts device) {
    return !isBusy(s.phase()) && admits(s.plugin(), environment) && ReadinessPolicy.canStartMethod(readiness, device, method.readiness());
  }

  public static boolean canReauthenticate(State s, Environment environment, Method method, Readiness readiness, DeviceFacts device, Account account) {
    return canStart(s, environment, method, readiness, device) && method != Method.GOOGLE_PICKER && !account.userId().isEmpty();
  }

  private static Step unchanged(State s) { return new Step(s, List.of()); }

  private static Step rest(Phase phase, Verdict verdict, State s) {
    return new Step(s.at(phase, 0), List.of(new Effect.Settled(s.open(), s.attempt(), verdict)));
  }

  public static Failure failureOf(boolean checkingCode, RefusalCode code, Reason reason) {
    if (code == RefusalCode.RATE_LIMITED || (code == RefusalCode.ACCESS_DENIED && reason == Reason.CHALLENGE_LOCKED)) return Failure.TOO_MANY_ATTEMPTS;
    if (code == RefusalCode.AUTHENTICATION_REQUIRED) return Failure.EXPIRED;
    if (code == RefusalCode.CREDENTIAL_PROOF_INVALID && checkingCode) return Failure.WRONG_CODE;
    if (code == RefusalCode.PROVIDER_UNAVAILABLE) return Failure.GOOGLE_UNAVAILABLE;
    if (code.retryable()) return Failure.UNAVAILABLE;
    return Failure.REJECTED;
  }

  private static State endedState(Failure failure, State s) {
    boolean held = s.serverCode() == ServerCode.HELD_CODE;
    return new State(s.plugin(), s.lastRequest(), 0, s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(), Phase.failed(failure),
      held ? ServerCode.DROPPED_CODE : s.serverCode(), held ? GoogleReport.GOOGLE_REFUSED : s.google(), s.credentialId());
  }

  private static Step endWith(Failure failure, State s) {
    return new Step(endedState(failure, s), List.of(new Effect.Settled(s.open(), s.attempt(), Verdict.ended(failure))));
  }

  private static Step checkRefused(Stage stage, Failure failure, State s) {
    if (stage != Stage.GOOGLE_STAGE && (failure == Failure.WRONG_CODE || failure == Failure.UNAVAILABLE))
      return rest(stage == Stage.FACTOR_STAGE ? Phase.SECOND_FACTOR : Phase.CODE_SENT, Verdict.tryAgain(failure), s);
    return endWith(failure, s);
  }

  public static boolean canVerify(State s, int attempt) {
    return attempt == s.attempt() && (s.phase().tag() == PhaseTag.CODE_SENT || s.phase().tag() == PhaseTag.SECOND_FACTOR);
  }

  private static State verify(State s) {
    Stage stage = s.phase().tag() == PhaseTag.SECOND_FACTOR ? Stage.FACTOR_STAGE : Stage.CODE_STAGE;
    return new State(s.plugin(), s.lastRequest() + 1, s.lastRequest() + 1, s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
      Phase.verifying(stage), s.serverCode(), s.google(), s.credentialId());
  }

  private static boolean authenticatedFits(CloudReply reply) {
    return !(reply instanceof CloudReply.Authenticated a) || (!a.userId().isEmpty() && a.credentialAttempt() >= 1 && a.accessExpiresAt() > 0);
  }

  private static boolean replyFits(Phase phase, CloudReply reply) {
    return switch (phase.tag()) {
      case SENDING -> reply instanceof CloudReply.Delivered || reply instanceof CloudReply.Unanswered || reply instanceof CloudReply.Refused;
      case VERIFYING -> !(reply instanceof CloudReply.Delivered) && authenticatedFits(reply);
      default -> false;
    };
  }

  private static Step sendFailed(int fallback, Failure failure, State s) {
    if (fallback < 1) return endWith(failure, s);
    State kept = new State(s.plugin(), s.lastRequest(), 0, s.lastAttempt(), fallback, s.environment(), s.method(), s.purpose(), Phase.CODE_SENT,
      s.serverCode(), s.google(), s.credentialId());
    return new Step(kept, List.of(new Effect.Settled(s.open(), fallback, Verdict.tryAgain(failure))));
  }

  private static Step sendAnswered(int fallback, CloudReply reply, State s) {
    if (reply instanceof CloudReply.Delivered) return rest(Phase.CODE_SENT, Verdict.of(VerdictTag.CODE_ON_ITS_WAY), s);
    if (reply instanceof CloudReply.Refused r) return sendFailed(fallback, failureOf(false, r.code(), r.reason()), s);
    if (reply instanceof CloudReply.Unanswered) return sendFailed(fallback, Failure.UNAVAILABLE, s);
    return unchanged(s);
  }

  private static Step checkAnswered(Stage stage, CloudReply reply, State s) {
    if (reply instanceof CloudReply.Authenticated a) return authenticated(stage, a, s);
    if (reply instanceof CloudReply.FactorRequired) return rest(Phase.SECOND_FACTOR, Verdict.of(VerdictTag.FACTOR_ASKED), s);
    if (reply instanceof CloudReply.Refused r) return checkRefused(stage, failureOf(stage != Stage.GOOGLE_STAGE, r.code(), r.reason()), s);
    if (reply instanceof CloudReply.Unanswered) return checkRefused(stage, Failure.UNAVAILABLE, s);
    return unchanged(s);
  }

  public static boolean canCloudAnswered(State s, int attempt, CloudReply reply) {
    return attempt >= 1 && attempt == s.attempt() && replyFits(s.phase(), reply);
  }

  private static Step cloudAnswered(State s, CloudReply reply) {
    return switch (s.phase().tag()) {
      case SENDING -> sendAnswered(s.phase().fallback(), reply, s);
      case VERIFYING -> checkAnswered(s.phase().stage(), reply, s);
      default -> unchanged(s);
    };
  }

  private static Step authenticated(Stage stage, CloudReply.Authenticated a, State s) {
    boolean redeemed = stage == Stage.GOOGLE_STAGE && s.serverCode() == ServerCode.HELD_CODE;
    if (s.purpose().reauthenticating()) {
      Account account = s.purpose().account();
      if (!a.userId().equals(account.userId())) return endWith(Failure.WRONG_ACCOUNT, s);
      return new Step(s.at(Phase.REAUTHENTICATED, 0), List.of(new Effect.Settled(s.open(), s.attempt(), Verdict.of(VerdictTag.ACCOUNT_CONFIRMED)),
        new Effect.HandSession(account, a.accessExpiresAt())));
    }
    GoogleReport google = redeemed ? (a.google() == GoogleReport.GOOGLE_CONNECTED ? GoogleReport.GOOGLE_CONNECTED : GoogleReport.GOOGLE_REFUSED) : s.google();
    return new Step(new State(s.plugin(), s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
      Phase.exchanging(a.credentialAttempt()), redeemed ? ServerCode.SPENT_CODE : s.serverCode(), google, s.credentialId()), List.of());
  }

  private static boolean keyNamed(KeyOutcome key) { return key.tag() == KeyTag.KEY_REFUSED || !key.credentialId().isEmpty(); }

  public static boolean canExchangeSettled(State s, int credentialAttempt, KeyOutcome key) {
    return s.phase().equals(Phase.exchanging(credentialAttempt)) && keyNamed(key);
  }

  private static Step exchangeSettled(State s, KeyOutcome key) {
    if (key.tag() == KeyTag.KEY_REFUSED) return endWith(Failure.EXPIRED, s);
    if (s.serverCode() == ServerCode.HELD_CODE) {
      return new Step(new State(s.plugin(), s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
        Phase.CONNECTING, ServerCode.SPENT_CODE, s.google(), key.credentialId()), List.of(new Effect.ConnectGoogle()));
    }
    State named = new State(s.plugin(), s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
      s.phase(), s.serverCode(), s.google(), key.credentialId());
    return rest(Phase.SIGNED_IN, Verdict.signedInAs(key.credentialId(), s.google()), named);
  }

  public static boolean canPickerAnswered(State s, int attempt) { return attempt == s.attempt() && s.phase().tag() == PhaseTag.PICKING; }

  private static Step pickerAnswered(State s, PickerResult picked) {
    return switch (picked.tag()) {
      case PICKED -> {
        boolean scoped = scopesRegistered(s.plugin());
        yield new Step(new State(s.plugin(), s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
          Phase.verifying(Stage.GOOGLE_STAGE), scoped && picked.granted() ? ServerCode.HELD_CODE : ServerCode.NO_SERVER_CODE,
          scoped && !picked.granted() ? GoogleReport.GOOGLE_REFUSED : GoogleReport.GOOGLE_NOT_REQUESTED, s.credentialId()), List.of());
      }
      case PICKER_DISMISSED -> endWith(Failure.CANCELLED, s);
      case NO_GOOGLE_ACCOUNT -> endWith(Failure.GOOGLE_UNAVAILABLE, s);
    };
  }

  public static boolean canGoogleConnected(State s, int attempt) { return attempt == s.attempt() && s.phase().tag() == PhaseTag.CONNECTING; }

  private static Step googleConnected(State s, boolean connected) {
    GoogleReport report = connected ? GoogleReport.GOOGLE_CONNECTED : GoogleReport.GOOGLE_REFUSED;
    State reported = new State(s.plugin(), s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(),
      s.phase(), s.serverCode(), report, s.credentialId());
    return rest(Phase.SIGNED_IN, Verdict.signedInAs(s.credentialId(), report), reported);
  }

  public static boolean canResend(State s, int attempt) { return attempt == s.attempt() && s.phase().tag() == PhaseTag.CODE_SENT; }

  private static State resend(State s) {
    return new State(s.plugin(), s.lastRequest() + 1, s.lastRequest() + 1, s.lastAttempt() + 1, s.lastAttempt() + 1, s.environment(), s.method(),
      s.purpose(), Phase.sending(s.attempt()), s.serverCode(), s.google(), s.credentialId());
  }

  public static boolean cancellable(Phase phase) {
    return switch (phase.tag()) {
      case IDLE, CONNECTING, SIGNED_IN, REAUTHENTICATED, FAILED -> false;
      default -> true;
    };
  }

  public static boolean ownsCancel(State s, int attempt) {
    int fallback = fallbackOf(s.phase());
    return cancellable(s.phase()) && (attempt == s.attempt() || (fallback >= 1 && attempt == fallback));
  }

  public static boolean canCancel(State s, int attempt) { return attempt >= 1 && attempt <= s.lastAttempt(); }

  private static Step cancel(State s, int attempt) {
    if (!ownsCancel(s, attempt)) return unchanged(s);
    State ended = endedState(Failure.CANCELLED, s);
    State idle = new State(ended.plugin(), ended.lastRequest(), ended.open(), ended.lastAttempt(), 0, ended.environment(), ended.method(),
      ended.purpose(), Phase.IDLE, ended.serverCode(), ended.google(), ended.credentialId());
    List<Effect> out = new ArrayList<>();
    if (s.open() != 0) out.add(new Effect.Settled(s.open(), s.attempt(), Verdict.ended(Failure.CANCELLED)));
    if (s.phase().tag() == PhaseTag.EXCHANGING && s.phase().credentialAttempt() >= 1) out.add(new Effect.AbandonExchange(s.phase().credentialAttempt()));
    return new Step(idle, List.copyOf(out));
  }

  public static boolean canExpire(State s, int attempt) {
    return attempt == s.attempt() && (s.phase().tag() == PhaseTag.CODE_SENT || s.phase().tag() == PhaseTag.SECOND_FACTOR);
  }

  public static boolean enabled(State s, Event event) {
    return switch (event) {
      case Event.Load load -> s.plugin().tag() == PluginTag.NOT_LOADED;
      case Event.Start start -> canStart(s, start.environment(), start.method(), start.readiness(), start.device());
      case Event.Unchanged unchanged -> true;
      case Event.Verify verify -> canVerify(s, verify.attempt());
      case Event.CloudAnswered answered -> canCloudAnswered(s, answered.attempt(), answered.reply());
      case Event.ExchangeSettled settled -> canExchangeSettled(s, settled.credentialAttempt(), settled.key());
      case Event.PickerAnswered picked -> canPickerAnswered(s, picked.attempt());
      case Event.GoogleConnected connected -> canGoogleConnected(s, connected.attempt());
      case Event.Resend resend -> canResend(s, resend.attempt());
      case Event.Cancel cancel -> canCancel(s, cancel.attempt());
      case Event.Expire expire -> canExpire(s, expire.attempt());
      case Event.Reauthenticate r -> canReauthenticate(s, r.environment(), r.method(), r.readiness(), r.device(), r.account());
    };
  }

  public static Step step(State s, Event event) {
    if (!enabled(s, event)) return unchanged(s);
    return switch (event) {
      case Event.Load load -> new Step(new State(load.registration().complete()
          ? Plugin.loaded(load.registration().googleScopes(), load.registration().testEnvironments() || load.build() == BuildKind.DEBUG_BUILD)
          : Plugin.REGISTRATION_REFUSED, s.lastRequest(), s.open(), s.lastAttempt(), s.attempt(), s.environment(), s.method(), s.purpose(), s.phase(),
        s.serverCode(), s.google(), s.credentialId()), List.of());
      case Event.Start start -> new Step(opened(start.environment(), start.method(), Purpose.SIGN_IN, s), List.of());
      case Event.Unchanged unchanged -> unchanged(s);
      case Event.Verify verify -> new Step(verify(s), List.of());
      case Event.CloudAnswered answered -> cloudAnswered(s, answered.reply());
      case Event.ExchangeSettled settled -> exchangeSettled(s, settled.key());
      case Event.PickerAnswered picked -> pickerAnswered(s, picked.picked());
      case Event.GoogleConnected connected -> googleConnected(s, connected.connected());
      case Event.Resend resend -> new Step(resend(s), List.of());
      case Event.Cancel cancel -> cancel(s, cancel.attempt());
      case Event.Expire expire -> new Step(endedState(Failure.EXPIRED, s), List.of());
      case Event.Reauthenticate r -> new Step(opened(r.environment(), r.method(), Purpose.reauthenticate(r.account()), s), List.of());
    };
  }

  private static boolean fitsMethod(Phase phase, Method method) {
    return switch (phase.tag()) {
      case SENDING, CODE_SENT -> method.code();
      case PICKING -> method == Method.GOOGLE_PICKER;
      case VERIFYING -> phase.stage() == Stage.CODE_STAGE ? method.code() : phase.stage() != Stage.GOOGLE_STAGE || !method.code();
      default -> true;
    };
  }

  private static boolean scopedPicker(State s) {
    return scopesRegistered(s.plugin()) && s.method() == Method.GOOGLE_PICKER && !s.purpose().reauthenticating();
  }

  private static boolean holdsCode(Phase phase) {
    return switch (phase.tag()) {
      case VERIFYING -> phase.stage() != Stage.CODE_STAGE;
      case SECOND_FACTOR, EXCHANGING -> true;
      default -> false;
    };
  }

  private static boolean pastPicker(Phase phase) {
    return switch (phase.tag()) {
      case VERIFYING, SECOND_FACTOR, EXCHANGING, SIGNED_IN -> true;
      default -> false;
    };
  }

  private static boolean reauthFits(State s) {
    if (!s.purpose().reauthenticating()) return s.phase().tag() != PhaseTag.REAUTHENTICATED;
    return !s.purpose().account().userId().isEmpty() && s.method() != Method.GOOGLE_PICKER
      && s.phase().tag() != PhaseTag.SIGNED_IN && s.phase().tag() != PhaseTag.CONNECTING;
  }

  public static boolean invariant(State s) {
    PhaseTag tag = s.phase().tag();
    int fallback = fallbackOf(s.phase());
    boolean registered = isLoaded(s.plugin()) || (tag == PhaseTag.IDLE && s.lastAttempt() == 0 && s.lastRequest() == 0);
    boolean admitted = tag == PhaseTag.IDLE || admits(s.plugin(), s.environment());
    boolean requests = s.open() >= 0 && s.open() <= s.lastRequest() && ((s.open() != 0) == isBusy(s.phase()));
    boolean attempts = s.attempt() >= 0 && s.attempt() <= s.lastAttempt() && ((s.attempt() == 0) == (tag == PhaseTag.IDLE))
      && fallback >= 0 && fallback < s.attempt() + (s.attempt() == 0 ? 1 : 0);
    boolean exchange = tag != PhaseTag.EXCHANGING || (s.phase().credentialAttempt() >= 1 && !s.purpose().reauthenticating());
    boolean credential = (tag != PhaseTag.SIGNED_IN && tag != PhaseTag.CONNECTING) || (!s.credentialId().isEmpty() && !s.purpose().reauthenticating());
    boolean serverCode = (s.serverCode() == ServerCode.NO_SERVER_CODE || scopedPicker(s))
      && (s.serverCode() != ServerCode.HELD_CODE || (holdsCode(s.phase()) && s.google() == GoogleReport.GOOGLE_NOT_REQUESTED))
      && (tag != PhaseTag.CONNECTING || s.serverCode() == ServerCode.SPENT_CODE);
    boolean googleAsked = s.google() == GoogleReport.GOOGLE_NOT_REQUESTED || scopedPicker(s);
    boolean googleReported = !(scopedPicker(s) && pastPicker(s.phase())) || s.serverCode() == ServerCode.HELD_CODE || s.google() != GoogleReport.GOOGLE_NOT_REQUESTED;
    return registered && admitted && fitsMethod(s.phase(), s.method()) && requests && attempts && exchange && credential && serverCode
      && googleAsked && googleReported && reauthFits(s);
  }

  public static CloudReply refusal(int status, String error, String reason) {
    RefusalCode code = RefusalCode.ofWire(error);
    if (code == null) {
      code = switch (status) {
        case 400 -> RefusalCode.INVALID_REQUEST;
        case 401 -> RefusalCode.AUTHENTICATION_REQUIRED;
        case 403 -> RefusalCode.ACCESS_DENIED;
        case 404 -> RefusalCode.NOT_FOUND;
        case 410 -> RefusalCode.SESSION_CLOSED;
        case 429 -> RefusalCode.RATE_LIMITED;
        case 502 -> RefusalCode.PROVIDER_INVALID_RESPONSE;
        case 503 -> RefusalCode.SERVICE_UNAVAILABLE;
        default -> null;
      };
      if (code == null) return new CloudReply.Unanswered();
    }
    Reason read = Reason.ofWire(reason == null ? "" : reason);
    return new CloudReply.Refused(code, reasonFits(code, read) ? read
      : code == RefusalCode.AUTHENTICATION_REQUIRED ? Reason.CREDENTIAL_UNKNOWN : Reason.NO_REASON);
  }

  private static boolean reasonFits(RefusalCode code, Reason reason) {
    if (code == RefusalCode.AUTHENTICATION_REQUIRED) return reason.credential();
    if (reason == Reason.NO_REASON) return true;
    return switch (code) {
      case INVALID_REQUEST -> reason == Reason.GRANT_REQUIRED || reason == Reason.UNSUPPORTED_FIELD;
      case ACCESS_DENIED -> reason == Reason.CHALLENGE_LOCKED || reason == Reason.GOOGLE_ACCOUNT_CHANGED
        || reason == Reason.ACCOUNT_INACTIVE || reason == Reason.CAPABILITY_MISSING;
      case PROVIDER_UNAVAILABLE -> reason == Reason.GOOGLE_NOT_CONFIGURED;
      default -> false;
    };
  }

  public static final long DEFAULT_CODE_LIFETIME_MS = 600_000L;
  public static final long MAX_CODE_LIFETIME_MS = 900_000L;
  public static final long MAX_CHALLENGE_LIFETIME_MS = 600_000L;
  public static final long RESEND_COOLDOWN_MS = 30_000L;
  public static final long MAX_RESEND_WAIT_MS = 86_400_000L;

  private static final Pattern EMAIL = Pattern.compile("[^\\s@\\p{Cc}\\p{Cf}]+@[^\\s@\\p{Cc}\\p{Cf}]+\\.[^\\s@\\p{Cc}\\p{Cf}]+");
  private static final Pattern PHONE = Pattern.compile("\\+[1-9][0-9]{6,14}");
  private static final Pattern CODE = Pattern.compile("[0-9]{6}");
  private static final Pattern UUID = Pattern.compile("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  private static final Pattern NONCE = Pattern.compile("[A-Za-z0-9_-]{32,256}");
  private static final Pattern SERVER_CLIENT_ID = Pattern.compile("[0-9]+-[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com");
  private static final Pattern SERVER_CODE = Pattern.compile("[A-Za-z0-9/_.~-]{10,2048}");
  private static final Pattern ID_TOKEN = Pattern.compile("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+");
  private static final Pattern BEARER = Pattern.compile("[\\x21-\\x7e]{20,16384}");

  public static boolean validEmail(String value) { return value != null && value.length() <= 320 && EMAIL.matcher(value).matches(); }
  public static boolean validPhone(String value) { return value != null && PHONE.matcher(value).matches(); }
  public static boolean validCode(String value) { return value != null && CODE.matcher(value).matches(); }
  public static boolean validUuid(String value) { return value != null && UUID.matcher(value).matches(); }
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

  public static long challengeExpiresAt(Object expiresAt, long now) {
    long value = instant(expiresAt);
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
