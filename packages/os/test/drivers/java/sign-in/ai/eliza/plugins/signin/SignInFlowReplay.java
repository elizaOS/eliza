// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Connect my Google mail and calendar with the same sign-in"; spec/os/signIn/flow.md, "Story: Cancel or resend exactly the request I mean"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.SignInPolicy.Event;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.Google;
import ai.eliza.plugins.signin.SignInPolicy.Method;
import ai.eliza.plugins.signin.SignInPolicy.Purpose;
import ai.eliza.plugins.signin.SignInPolicy.State;
import ai.eliza.plugins.signin.SignInPolicy.Verify;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class SignInFlowReplay {
  private static final Pattern EVENT = Pattern.compile("\"event\"\\s*:\\s*(\\{.*\\})");

  private State state = SignInPolicy.INITIAL;

  private static String pascal(Enum<?> value) {
    StringBuilder out = new StringBuilder();
    for (String part : value.name().toLowerCase(Locale.ROOT).split("_")) out.append(Character.toUpperCase(part.charAt(0))).append(part.substring(1));
    return out.toString();
  }

  private static <T extends Enum<T>> T named(Class<T> type, String wire) {
    for (T value : type.getEnumConstants()) if (pascal(value).equals(wire)) return value;
    throw new IllegalArgumentException(type.getSimpleName() + " " + wire);
  }

  private static String field(String body, String name) {
    Matcher matcher = Pattern.compile("\"" + name + "\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|true|false)").matcher(body);
    if (!matcher.find()) throw new IllegalArgumentException("missing " + name);
    return matcher.group(2) != null ? matcher.group(2) : matcher.group(1);
  }

  private static Event event(String body) {
    String request = field(body, "request");
    return switch (field(body, "type")) {
      case "open" -> new Event.Open(request, named(Method.class, field(body, "method")), named(Purpose.class, field(body, "purpose")));
      case "resend" -> new Event.Resend(request);
      case "codeSent" -> new Event.CodeSent(request);
      case "submit" -> new Event.Submit(request);
      case "verifyAnswered" -> new Event.VerifyAnswered(request, named(Verify.class, field(body, "answer")));
      case "proofReady" -> new Event.ProofReady(request, named(Google.class, field(body, "google")));
      case "factorRequired" -> new Event.FactorRequired(request);
      case "acknowledged" -> new Event.Acknowledged(request, field(body, "credentialId"));
      case "googleSettled" -> new Event.GoogleSettled(request, Boolean.parseBoolean(field(body, "connected")));
      case "fail" -> new Event.Fail(request, named(Failure.class, field(body, "failure")));
      case "cancel" -> new Event.Cancel(request);
      default -> throw new IllegalArgumentException("event " + body);
    };
  }

  private static String quote(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  private String state() {
    return "{\"attempt\":" + state.attempt() + ",\"request\":" + quote(state.request()) + ",\"resend\":" + quote(state.resend())
      + ",\"method\":" + quote(pascal(state.method())) + ",\"purpose\":" + quote(pascal(state.purpose()))
      + ",\"step\":" + quote(pascal(state.step())) + ",\"factor\":" + state.factor() + ",\"google\":" + quote(pascal(state.google()))
      + ",\"credentialId\":" + quote(state.credentialId()) + ",\"failure\":" + (state.failure() == null ? "null" : quote(pascal(state.failure()))) + "}";
  }

  private String answer(String line) {
    Matcher wrapped = EVENT.matcher(line);
    if (!wrapped.find()) {
      state = SignInPolicy.INITIAL;
      return "{\"state\":" + state() + "}";
    }
    Event event = event(wrapped.group(1));
    boolean accepted = SignInPolicy.enabled(state, event);
    if (accepted) state = SignInPolicy.step(state, event);
    if (!SignInPolicy.invariant(state)) throw new IllegalStateException("invariant broken after " + event);
    return "{\"state\":" + state() + ",\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\"}";
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
