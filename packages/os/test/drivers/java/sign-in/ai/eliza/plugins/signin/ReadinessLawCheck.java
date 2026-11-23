// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.ReadinessPolicy.*;
import java.util.List;

/** Prints one JSON line per case: the generated function's name, its arguments in generated shape, and what ReadinessPolicy answers. */
public final class ReadinessLawCheck {
  private ReadinessLawCheck() {}

  private static final CloudMethods ALL = new CloudMethods(true, true, true, true, true);
  private static final CloudMethods NONE = new CloudMethods(false, false, false, false, false);
  private static final CloudMethods PART = new CloudMethods(true, false, true, true, false);
  private static final List<Readiness> READINESS = List.of(Readiness.NOT_MEASURED, Readiness.UNKNOWN,
    Readiness.known(ALL), Readiness.known(NONE), Readiness.known(PART));
  private static final List<DeviceFacts> DEVICES = List.of(
    new DeviceFacts(GoogleMode.PICKER, false, false),
    new DeviceFacts(GoogleMode.PICKER, true, true),
    new DeviceFacts(GoogleMode.PICKER, true, true, true),
    new DeviceFacts(GoogleMode.PICKER, false, true, true),
    new DeviceFacts(GoogleMode.PICKER, true, false, true),
    new DeviceFacts(GoogleMode.BROWSER, true, true),
    new DeviceFacts(GoogleMode.BROWSER, true, false));
  private static final List<Long> NOWS = List.of(0L, 29_999L, 30_000L, 600_000L, 21_600_000L);
  private static final List<Answer> CACHED = List.of(ReadinessPolicy.NO_ANSWER,
    new Answer(Readiness.known(PART), 21_600_000L, 30_000L, 120_000L, 1),
    new Answer(Readiness.known(ALL), 21_600_000L, 21_600_000L, 21_600_000L, 0),
    new Answer(Readiness.UNKNOWN, 600_000L, 30_000L, 30_000L, 0),
    new Answer(Readiness.known(NONE), 50_000_000L, 30_000L, 30_000L, 0));
  private static final List<CloudReading> READINGS = List.of(CloudReading.NO_READING, CloudReading.CLIENT_UNREGISTERED,
    CloudReading.methodsRead(ALL), CloudReading.methodsRead(PART), CloudReading.methodsRead(NONE));
  private static final List<SignInMethod> METHODS = List.of(SignInMethod.EMAIL_CODE, SignInMethod.SMS_CODE,
    SignInMethod.google(GoogleMode.PICKER), SignInMethod.google(GoogleMode.BROWSER));
  private static final List<GoogleMode> MODES = List.of(GoogleMode.PICKER, GoogleMode.BROWSER);
  private static final List<Boolean> BOOLS = List.of(false, true);
  private static final List<Long> ASKED = List.of(0L, 1L, 21_000_000L, 21_500_000L, 30_000L);
  private static final String HOST = "ai.example.phone";
  private static final List<String> PACKAGES = List.of("", HOST, ReadinessPolicy.WEBVIEW_SHELL_PACKAGE, "com.android.chrome", "org.mozilla.firefox", "android");
  private static final List<List<String>> HANDLERS = List.of(List.of(), List.of(ReadinessPolicy.WEBVIEW_SHELL_PACKAGE),
    List.of(HOST, ReadinessPolicy.WEBVIEW_SHELL_PACKAGE), List.of(ReadinessPolicy.WEBVIEW_SHELL_PACKAGE, "com.android.chrome"),
    List.of("com.android.chrome", "org.mozilla.firefox"));

  private static void emit(String fn, Object result, String... args) {
    System.out.println("{\"fn\":\"" + fn + "\",\"args\":[" + String.join(",", args) + "],\"result\":" + result + "}");
  }

  private static String q(String value) { return "\"" + value + "\""; }
  private static String mode(GoogleMode m) { return q(m == GoogleMode.PICKER ? "Picker" : "Browser"); }

  private static String methods(CloudMethods m) {
    return "\"email\":" + m.email + ",\"sms\":" + m.sms + ",\"google\":" + m.google + ",\"nativeSignIn\":" + m.nativeSignIn + ",\"serverClientId\":" + m.serverClientId;
  }

  private static String readiness(Readiness r) {
    switch (r.tag) {
      case NOT_MEASURED: return "{\"tag\":\"NotMeasured\"}";
      case UNKNOWN: return "{\"tag\":\"ReadinessUnknown\"}";
      default: return "{\"tag\":\"Known\"," + methods(r.methods) + "}";
    }
  }

  private static String device(DeviceFacts d) {
    return "{\"googleMode\":" + mode(d.googleMode) + ",\"appLinkVerified\":" + d.appLinkVerified + ",\"externalBrowser\":" + d.externalBrowser + ",\"browserFallback\":" + d.browserFallback + "}";
  }

  private static String method(SignInMethod m) {
    return m.tag == MethodTag.EMAIL_CODE ? "{\"tag\":\"EmailCode\"}" : m.tag == MethodTag.SMS_CODE ? "{\"tag\":\"SmsCode\"}"
      : "{\"tag\":\"Google\",\"mode\":" + mode(m.mode) + "}";
  }

  private static String answer(Answer a) {
    return "{\"readiness\":" + readiness(a.readiness) + ",\"until\":" + a.until + ",\"recheckAt\":" + a.recheckAt
      + ",\"passiveAt\":" + a.passiveAt + ",\"unchanged\":" + a.unchanged + "}";
  }

  private static String reading(CloudReading r) {
    return r.tag == ReadingTag.NO_READING ? "{\"tag\":\"NoReading\"}" : r.tag == ReadingTag.CLIENT_UNREGISTERED ? "{\"tag\":\"ClientUnregistered\"}"
      : "{\"tag\":\"MethodsRead\"," + methods(r.methods) + "}";
  }

  private static String list(List<String> values) {
    return "[" + String.join(",", values.stream().map(ReadinessLawCheck::q).toList()) + "]";
  }

  private static String plan(StatusPlan p) { return "{\"serveNow\":" + p.serveNow + ",\"measure\":" + p.measure + "}"; }

  private static String outcome(ServiceOutcome o) {
    return q(o == ServiceOutcome.SERVICE_SHOWN ? "ServiceShown" : o == ServiceOutcome.SERVICE_UNAVAILABLE ? "ServiceUnavailable" : "ServiceUnknownEnvironment");
  }

  private static boolean implies(boolean a, boolean b) { return !a || b; }

  public static void main(String[] args) {
    for (Readiness r : READINESS) {
      for (GoogleMode m : MODES) emit("readinessComplete", ReadinessPolicy.readinessComplete(r, m), readiness(r), mode(m));
      emit("anyReady", ReadinessPolicy.anyReady(r), readiness(r));
      for (DeviceFacts d : DEVICES) {
        for (SignInMethod m : METHODS) {
          boolean offered = ReadinessPolicy.offered(r, d, m);
          boolean admitted = ReadinessPolicy.canStartMethod(r, d, m);
          emit("offered", offered, readiness(r), device(d), method(m));
          emit("canStartMethod", admitted, readiness(r), device(d), method(m));
          emit("lawExtraGoogleStartNeedsBrowserFallback", implies(admitted && !offered,
            d.browserFallback && d.googleMode == GoogleMode.PICKER && m.tag == MethodTag.GOOGLE
              && m.mode == GoogleMode.BROWSER && d.appLinkVerified && d.externalBrowser),
            readiness(r), device(d), method(m));
        }
        emit("lawOneGoogleButtonAtMost", !(ReadinessPolicy.offered(r, d, SignInMethod.google(GoogleMode.PICKER))
          && ReadinessPolicy.offered(r, d, SignInMethod.google(GoogleMode.BROWSER))), readiness(r), device(d));
      }
      for (Readiness measured : READINESS) emit("announces", ReadinessPolicy.announces(r, measured), readiness(r), readiness(measured));
    }
    for (int unchanged = -1; unchanged <= 5; unchanged++) emit("passiveWait", ReadinessPolicy.passiveWait(unchanged), String.valueOf(unchanged));
    for (Answer c : CACHED) {
      for (GoogleMode g : MODES) {
        for (long now : NOWS) {
          emit("answerFresh", ReadinessPolicy.answerFresh(c, now), answer(c), String.valueOf(now));
          emit("recheckDue", ReadinessPolicy.recheckDue(c, g, now), answer(c), mode(g), String.valueOf(now));
          emit("passiveDue", ReadinessPolicy.passiveDue(c, g, now), answer(c), mode(g), String.valueOf(now));
          emit("onLoad", ReadinessPolicy.onLoad(c, g, now), answer(c), mode(g), String.valueOf(now));
          StatusPlan served = ReadinessPolicy.onStatus(c, g, now, false);
          emit("lawFreshAnswerServedAtOnce", implies(ReadinessPolicy.answerFresh(c, now), served.serveNow), answer(c), mode(g), String.valueOf(now));
          emit("lawNotReadyMeasuredBehindAnswer", implies(ReadinessPolicy.answerFresh(c, now) && ReadinessPolicy.recheckDue(c, g, now), served.serveNow && served.measure),
            answer(c), mode(g), String.valueOf(now));
          Answer unread = ReadinessPolicy.measureAnswer(c, CloudReading.NO_READING, g, now);
          emit("lawNoReadingKeepsFreshAnswer", implies(ReadinessPolicy.answerFresh(c, now), unread.readiness.equals(c.readiness) && unread.until == c.until),
            answer(c), mode(g), String.valueOf(now));
          emit("lawNoReadingOverFreshAnswerAnnouncesNothing", implies(ReadinessPolicy.answerFresh(c, now), !ReadinessPolicy.announces(c.readiness, unread.readiness)),
            answer(c), mode(g), String.valueOf(now));
          for (boolean retry : BOOLS) {
            StatusPlan p = ReadinessPolicy.onStatus(c, g, now, retry);
            emit("onStatus", plan(p), answer(c), mode(g), String.valueOf(now), String.valueOf(retry));
            emit("lawNothingFreshWaitsForAProbe", implies(!ReadinessPolicy.answerFresh(c, now), p.measure && !p.serveNow), answer(c), mode(g), String.valueOf(now), String.valueOf(retry));
            emit("lawCompleteAnswerNotMeasured", implies(ReadinessPolicy.answerFresh(c, now) && ReadinessPolicy.readinessComplete(c.readiness, g), !p.measure),
              answer(c), mode(g), String.valueOf(now), String.valueOf(retry));
          }
          for (long asked : ASKED) for (boolean attempt : BOOLS) {
            emit("onResume", ReadinessPolicy.onResume(c, g, now, asked, attempt), answer(c), mode(g), String.valueOf(now), String.valueOf(asked), String.valueOf(attempt));
          }
          for (CloudReading r : READINGS) {
            Answer after = ReadinessPolicy.measureAnswer(c, r, g, now);
            emit("measureAnswer", answer(after), answer(c), reading(r), mode(g), String.valueOf(now));
            emit("lawReadyAnswerLivesSixHours", implies(r.tag != ReadingTag.NO_READING && ReadinessPolicy.anyReady(after.readiness),
              ReadinessPolicy.answerFresh(after, now + ReadinessPolicy.READY_TTL_MS - 1) && !ReadinessPolicy.answerFresh(after, now + ReadinessPolicy.READY_TTL_MS)),
              answer(c), reading(r), mode(g), String.valueOf(now));
            emit("lawNotCompleteRecheckedWithinThirtySeconds", implies(!ReadinessPolicy.readinessComplete(after.readiness, g), ReadinessPolicy.recheckDue(after, g, now + ReadinessPolicy.RECHECK_MS)),
              answer(c), reading(r), mode(g), String.valueOf(now));
            emit("lawPassiveWaitNeverBeforeRecheck", after.recheckAt <= after.passiveAt && after.passiveAt <= after.until, answer(c), reading(r), mode(g), String.valueOf(now));
          }
          for (DeviceFacts d : DEVICES) {
            if (d.googleMode != g) continue;
            for (SignInMethod m : METHODS) {
              Answer after = ReadinessPolicy.measureAnswer(c, CloudReading.NO_READING, g, now);
              emit("lawNoReadingNeverOffersMore", implies(ReadinessPolicy.offered(after.readiness, d, m), ReadinessPolicy.offered(c.readiness, d, m)),
                answer(c), device(d), method(m), String.valueOf(now));
            }
          }
        }
      }
    }
    for (String candidate : PACKAGES) {
      emit("externalBrowserPackage", ReadinessPolicy.externalBrowserPackage(candidate, HOST), q(candidate), q(HOST));
      for (List<String> handlers : HANDLERS) {
        emit("browserToOpen", q(ReadinessPolicy.browserToOpen(handlers, candidate, HOST)), list(handlers), q(candidate), q(HOST));
      }
    }
    for (boolean registered : BOOLS) for (int status : new int[] {0, 200, 404, 503}) for (boolean wellFormed : BOOLS) {
      emit("serviceOutcome", outcome(ReadinessPolicy.serviceOutcome(registered, status, wellFormed)), String.valueOf(registered), String.valueOf(status), String.valueOf(wellFormed));
    }
  }
}
