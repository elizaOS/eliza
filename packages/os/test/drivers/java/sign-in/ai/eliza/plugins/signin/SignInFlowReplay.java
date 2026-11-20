// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.ReadinessPolicy.CloudMethods;
import ai.eliza.plugins.signin.ReadinessPolicy.DeviceFacts;
import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import ai.eliza.plugins.signin.ReadinessPolicy.Readiness;
import ai.eliza.plugins.signin.SignInPolicy.BuildKind;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInPolicy.Effect;
import ai.eliza.plugins.signin.SignInPolicy.Environment;
import ai.eliza.plugins.signin.SignInPolicy.Event;
import ai.eliza.plugins.signin.SignInPolicy.GoogleReport;
import ai.eliza.plugins.signin.SignInPolicy.KeyOutcome;
import ai.eliza.plugins.signin.SignInPolicy.Method;
import ai.eliza.plugins.signin.SignInPolicy.Phase;
import ai.eliza.plugins.signin.SignInPolicy.PickerResult;
import ai.eliza.plugins.signin.SignInPolicy.RefusalCode;
import ai.eliza.plugins.signin.SignInPolicy.Registration;
import ai.eliza.plugins.signin.SignInPolicy.State;
import ai.eliza.plugins.signin.SignInPolicy.Step;
import ai.eliza.plugins.signin.SignInPolicy.Verdict;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class SignInFlowReplay {
  private State state = SignInPolicy.INITIAL;

  private static String pascal(Enum<?> value) {
    StringBuilder out = new StringBuilder();
    for (String part : value.name().toLowerCase(Locale.ROOT).split("_")) out.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
    return out.toString();
  }

  private static <T extends Enum<T>> T named(Class<T> type, Object wire) {
    for (T value : type.getEnumConstants()) if (pascal(value).equals(wire)) return value;
    throw new IllegalArgumentException(type.getSimpleName() + " " + wire);
  }

  private static Map<String, Object> object(Map<String, Object> source, String key) { return CredentialJson.object(source.get(key), key); }

  private static String tag(Map<String, Object> source) { return CredentialJson.text(source, "tag"); }

  private static Method method(Map<String, Object> raw) {
    return switch (tag(raw)) {
      case "EmailCode" -> Method.EMAIL_CODE;
      case "SmsCode" -> Method.SMS_CODE;
      case "Google" -> Method.google(named(GoogleMode.class, raw.get("mode")));
      default -> throw new IllegalArgumentException("method " + raw);
    };
  }

  private static Readiness readiness(Map<String, Object> raw) {
    return switch (tag(raw)) {
      case "NotMeasured" -> Readiness.NOT_MEASURED;
      case "ReadinessUnknown" -> Readiness.UNKNOWN;
      case "Known" -> Readiness.known(new CloudMethods(CredentialJson.flag(raw, "email"), CredentialJson.flag(raw, "sms"),
        CredentialJson.flag(raw, "google"), CredentialJson.flag(raw, "nativeSignIn"), CredentialJson.flag(raw, "serverClientId")));
      default -> throw new IllegalArgumentException("readiness " + raw);
    };
  }

  private static DeviceFacts device(Map<String, Object> raw) {
    return new DeviceFacts(named(GoogleMode.class, raw.get("googleMode")), CredentialJson.flag(raw, "appLinkVerified"), CredentialJson.flag(raw, "externalBrowser"));
  }

  private static Account account(Map<String, Object> raw) { return new Account(CredentialJson.text(raw, "userId"), CredentialJson.text(raw, "organizationId")); }

  private static CloudReply reply(Map<String, Object> raw) {
    return switch (tag(raw)) {
      case "Delivered" -> new CloudReply.Delivered();
      case "Authenticated" -> new CloudReply.Authenticated(CredentialJson.text(raw, "userId"), CredentialJson.small(raw, "credentialAttempt"),
        CredentialJson.whole(raw, "accessExpiresAt"), named(GoogleReport.class, raw.get("google")));
      case "FactorRequired" -> new CloudReply.FactorRequired();
      case "Refused" -> new CloudReply.Refused(RefusalCode.ofTag(CredentialJson.text(raw, "code")), Reason.ofTag(CredentialJson.text(raw, "reason")));
      case "Unanswered" -> new CloudReply.Unanswered();
      default -> throw new IllegalArgumentException("reply " + raw);
    };
  }

  private static KeyOutcome key(Map<String, Object> raw) {
    return switch (tag(raw)) {
      case "KeyAcknowledged" -> KeyOutcome.acknowledged(CredentialJson.text(raw, "credentialId"));
      case "KeyRefused" -> KeyOutcome.REFUSED;
      default -> throw new IllegalArgumentException("key " + raw);
    };
  }

  private static PickerResult picked(Map<String, Object> raw) {
    return switch (tag(raw)) {
      case "Picked" -> PickerResult.picked(CredentialJson.flag(raw, "granted"));
      case "PickerDismissed" -> PickerResult.DISMISSED;
      case "NoGoogleAccount" -> PickerResult.NO_GOOGLE_ACCOUNT;
      default -> throw new IllegalArgumentException("picked " + raw);
    };
  }

  private static Event event(Map<String, Object> raw) {
    return switch (CredentialJson.text(raw, "type")) {
      case "load" -> {
        Map<String, Object> registration = object(raw, "registration");
        yield new Event.Load(new Registration(CredentialJson.flag(registration, "complete"), CredentialJson.flag(registration, "googleScopes"),
          CredentialJson.flag(registration, "testEnvironments")), named(BuildKind.class, raw.get("build")));
      }
      case "start" -> new Event.Start(named(Environment.class, raw.get("environment")), method(object(raw, "method")),
        readiness(object(raw, "readiness")), device(object(raw, "device")));
      case "unchanged" -> new Event.Unchanged();
      case "verify" -> new Event.Verify(CredentialJson.small(raw, "attempt"));
      case "cloudAnswered" -> new Event.CloudAnswered(CredentialJson.small(raw, "attempt"), reply(object(raw, "reply")));
      case "exchangeSettled" -> new Event.ExchangeSettled(CredentialJson.small(raw, "credentialAttempt"), key(object(raw, "key")));
      case "pickerAnswered" -> new Event.PickerAnswered(CredentialJson.small(raw, "attempt"), picked(object(raw, "picked")));
      case "googleConnected" -> new Event.GoogleConnected(CredentialJson.small(raw, "attempt"), CredentialJson.flag(raw, "connected"));
      case "resend" -> new Event.Resend(CredentialJson.small(raw, "attempt"));
      case "cancel" -> new Event.Cancel(CredentialJson.small(raw, "attempt"));
      case "expire" -> new Event.Expire(CredentialJson.small(raw, "attempt"));
      case "reauthenticate" -> new Event.Reauthenticate(named(Environment.class, raw.get("environment")), method(object(raw, "method")),
        readiness(object(raw, "readiness")), device(object(raw, "device")), account(object(raw, "account")));
      default -> throw new IllegalArgumentException("event " + raw);
    };
  }

  private static String quote(String value) { return CredentialJson.quote(value); }

  private static String tagged(Enum<?> value) { return "{\"tag\":" + quote(pascal(value)) + "}"; }

  private static String method(Method method) {
    return switch (method) {
      case EMAIL_CODE -> "{\"tag\":\"EmailCode\"}";
      case SMS_CODE -> "{\"tag\":\"SmsCode\"}";
      case GOOGLE_PICKER -> "{\"tag\":\"Google\",\"mode\":\"Picker\"}";
      case GOOGLE_BROWSER -> "{\"tag\":\"Google\",\"mode\":\"Browser\"}";
    };
  }

  private static String account(Account account) {
    return "{\"userId\":" + quote(account.userId()) + ",\"organizationId\":" + quote(account.organizationId()) + "}";
  }

  private static String phase(Phase phase) {
    String tag = "{\"tag\":" + quote(pascal(phase.tag()));
    return switch (phase.tag()) {
      case SENDING -> tag + ",\"fallback\":" + phase.fallback() + "}";
      case VERIFYING -> tag + ",\"stage\":" + quote(pascal(phase.stage())) + "}";
      case EXCHANGING -> tag + ",\"credentialAttempt\":" + phase.credentialAttempt() + "}";
      case FAILED -> tag + ",\"failure\":" + quote(pascal(phase.failure())) + "}";
      default -> tag + "}";
    };
  }

  private static String state(State s) {
    String plugin = switch (s.plugin().tag()) {
      case LOADED -> "{\"tag\":\"Loaded\",\"googleScopes\":" + s.plugin().googleScopes() + ",\"testEnvironments\":" + s.plugin().testEnvironments() + "}";
      default -> tagged(s.plugin().tag());
    };
    String purpose = s.purpose().reauthenticating()
      ? "{\"tag\":\"ReauthPurpose\",\"account\":" + account(s.purpose().account()) + "}" : "{\"tag\":\"SignInPurpose\"}";
    return "{\"plugin\":" + plugin + ",\"lastRequest\":" + s.lastRequest() + ",\"open\":" + s.open() + ",\"lastAttempt\":" + s.lastAttempt()
      + ",\"attempt\":" + s.attempt() + ",\"environment\":" + quote(pascal(s.environment())) + ",\"method\":" + method(s.method())
      + ",\"purpose\":" + purpose + ",\"phase\":" + phase(s.phase()) + ",\"serverCode\":" + quote(pascal(s.serverCode()))
      + ",\"google\":" + quote(pascal(s.google())) + ",\"credentialId\":" + quote(s.credentialId()) + "}";
  }

  private static String verdict(Verdict verdict) {
    String tag = "{\"tag\":" + quote(pascal(verdict.tag()));
    return switch (verdict.tag()) {
      case SIGNED_IN_AS -> tag + ",\"credentialId\":" + quote(verdict.credentialId()) + ",\"google\":" + quote(pascal(verdict.google())) + "}";
      case TRY_AGAIN -> tag + ",\"retry\":" + quote(pascal(verdict.failure())) + "}";
      case ENDED -> tag + ",\"problem\":" + quote(pascal(verdict.failure())) + "}";
      default -> tag + "}";
    };
  }

  private static String effect(Effect effect) {
    return switch (effect) {
      case Effect.Settled s -> "{\"tag\":\"Settled\",\"request\":" + s.request() + ",\"attempt\":" + s.attempt() + ",\"verdict\":" + verdict(s.verdict()) + "}";
      case Effect.ConnectGoogle c -> "{\"tag\":\"ConnectGoogle\"}";
      case Effect.AbandonExchange a -> "{\"tag\":\"AbandonExchange\",\"abandoned\":" + a.abandoned() + "}";
      case Effect.HandSession h -> "{\"tag\":\"HandSession\",\"account\":" + account(h.account()) + ",\"accessExpiresAt\":" + h.accessExpiresAt() + "}";
    };
  }

  private static String out(List<Effect> out) {
    StringBuilder text = new StringBuilder("[");
    for (Effect effect : out) text.append(text.length() > 1 ? "," : "").append(effect(effect));
    return text.append(']').toString();
  }

  private String answer(String line) {
    Map<String, Object> request = CredentialJson.object(CredentialJson.parse(line), "request");
    if (!request.containsKey("event")) {
      state = SignInPolicy.INITIAL;
      return "{\"state\":" + state(state) + ",\"out\":[]}";
    }
    Event event = event(CredentialJson.object(request.get("event"), "event"));
    boolean accepted = SignInPolicy.enabled(state, event);
    Step step = SignInPolicy.step(state, event);
    state = step.state();
    if (!SignInPolicy.invariant(state)) throw new IllegalStateException("invariant broken after " + event);
    return "{\"state\":" + state(state) + ",\"out\":" + out(step.out()) + ",\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\"}";
  }

  public static void main(String[] args) throws Exception {
    SignInFlowReplay replay = new SignInFlowReplay();
    PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = in.readLine(); line != null; line = in.readLine()) {
      try {
        out.println(replay.answer(line));
      } catch (RuntimeException broken) {
        out.println("{\"error\":" + quote(String.valueOf(broken.getMessage())) + "}");
      }
    }
  }
}
