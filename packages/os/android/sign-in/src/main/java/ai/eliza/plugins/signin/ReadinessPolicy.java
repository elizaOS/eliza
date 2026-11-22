// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; "Story: Read the service's own terms"
package ai.eliza.plugins.signin;

import java.util.Objects;

/** Framework-free mirror of gen/os__signIn__readiness.ts: the same names, the same rules, epoch milliseconds. */
public final class ReadinessPolicy {
  private ReadinessPolicy() {}

  public static final long READY_TTL_MS = 21_600_000L;
  public static final long NOT_READY_TTL_MS = 600_000L;
  public static final long RECHECK_MS = 30_000L;
  public static final long[] PASSIVE_WAITS_MS = {30_000L, 120_000L, 600_000L, 3_600_000L};
  public static final long RESUME_WINDOW_MS = 600_000L;

  public enum GoogleMode { PICKER, BROWSER }

  /** What one probe read of the cloud's methods. */
  public static final class CloudMethods {
    public final boolean email, sms, google, nativeSignIn, serverClientId;
    public CloudMethods(boolean email, boolean sms, boolean google, boolean nativeSignIn, boolean serverClientId) {
      this.email = email; this.sms = sms; this.google = google; this.nativeSignIn = nativeSignIn; this.serverClientId = serverClientId;
    }
    @Override public boolean equals(Object other) {
      return other instanceof CloudMethods m && email == m.email && sms == m.sms && google == m.google
        && nativeSignIn == m.nativeSignIn && serverClientId == m.serverClientId;
    }
    @Override public int hashCode() { return Objects.hash(email, sms, google, nativeSignIn, serverClientId); }
  }

  public enum ReadinessTag { NOT_MEASURED, UNKNOWN, KNOWN }

  public static final class Readiness {
    public final ReadinessTag tag;
    /** Non-null exactly when {@code tag} is KNOWN. */
    public final CloudMethods methods;
    private Readiness(ReadinessTag tag, CloudMethods methods) { this.tag = tag; this.methods = methods; }
    public static final Readiness NOT_MEASURED = new Readiness(ReadinessTag.NOT_MEASURED, null);
    public static final Readiness UNKNOWN = new Readiness(ReadinessTag.UNKNOWN, null);
    public static Readiness known(CloudMethods methods) { return new Readiness(ReadinessTag.KNOWN, Objects.requireNonNull(methods)); }
    @Override public boolean equals(Object other) {
      return other instanceof Readiness r && tag == r.tag && Objects.equals(methods, r.methods);
    }
    @Override public int hashCode() { return Objects.hash(tag, methods); }
  }

  public static final class DeviceFacts {
    public final GoogleMode googleMode;
    public final boolean appLinkVerified, externalBrowser, browserFallback;
    public DeviceFacts(GoogleMode googleMode, boolean appLinkVerified, boolean externalBrowser) {
      this(googleMode, appLinkVerified, externalBrowser, false);
    }
    public DeviceFacts(GoogleMode googleMode, boolean appLinkVerified, boolean externalBrowser, boolean browserFallback) {
      this.googleMode = googleMode; this.appLinkVerified = appLinkVerified; this.externalBrowser = externalBrowser;
      this.browserFallback = browserFallback;
    }
  }

  public enum MethodTag { EMAIL_CODE, SMS_CODE, GOOGLE }

  public static final class SignInMethod {
    public final MethodTag tag;
    /** Non-null exactly when {@code tag} is GOOGLE. */
    public final GoogleMode mode;
    private SignInMethod(MethodTag tag, GoogleMode mode) { this.tag = tag; this.mode = mode; }
    public static final SignInMethod EMAIL_CODE = new SignInMethod(MethodTag.EMAIL_CODE, null);
    public static final SignInMethod SMS_CODE = new SignInMethod(MethodTag.SMS_CODE, null);
    public static SignInMethod google(GoogleMode mode) { return new SignInMethod(MethodTag.GOOGLE, Objects.requireNonNull(mode)); }
  }

  public static final class Answer {
    public final Readiness readiness;
    public final long until, recheckAt, passiveAt;
    public final int unchanged;
    public Answer(Readiness readiness, long until, long recheckAt, long passiveAt, int unchanged) {
      this.readiness = readiness; this.until = until; this.recheckAt = recheckAt; this.passiveAt = passiveAt; this.unchanged = unchanged;
    }
  }

  public static final Answer NO_ANSWER = new Answer(Readiness.NOT_MEASURED, 0, 0, 0, 0);

  public static final class StatusPlan {
    public final boolean serveNow, measure;
    public StatusPlan(boolean serveNow, boolean measure) { this.serveNow = serveNow; this.measure = measure; }
  }

  public enum ReadingTag { NO_READING, CLIENT_UNREGISTERED, METHODS_READ }

  public static final class CloudReading {
    public final ReadingTag tag;
    /** Non-null exactly when {@code tag} is METHODS_READ. */
    public final CloudMethods methods;
    private CloudReading(ReadingTag tag, CloudMethods methods) { this.tag = tag; this.methods = methods; }
    public static final CloudReading NO_READING = new CloudReading(ReadingTag.NO_READING, null);
    public static final CloudReading CLIENT_UNREGISTERED = new CloudReading(ReadingTag.CLIENT_UNREGISTERED, null);
    public static CloudReading methodsRead(CloudMethods methods) { return new CloudReading(ReadingTag.METHODS_READ, Objects.requireNonNull(methods)); }
  }

  public enum ServiceOutcome { SERVICE_SHOWN, SERVICE_UNAVAILABLE, SERVICE_UNKNOWN_ENVIRONMENT }

  public static boolean offered(Readiness readiness, DeviceFacts device, SignInMethod method) {
    if (readiness.tag != ReadinessTag.KNOWN) return false;
    CloudMethods m = readiness.methods;
    switch (method.tag) {
      case EMAIL_CODE: return m.email;
      case SMS_CODE: return m.sms;
      default:
        return method.mode == device.googleMode && m.google
          && (method.mode == GoogleMode.PICKER ? m.nativeSignIn && m.serverClientId : device.appLinkVerified && device.externalBrowser);
    }
  }

  public static boolean canStartMethod(Readiness readiness, DeviceFacts device, SignInMethod method) {
    return offered(readiness, device, method) || (device.browserFallback && device.googleMode == GoogleMode.PICKER
      && method.tag == MethodTag.GOOGLE && method.mode == GoogleMode.BROWSER
      && readiness.tag == ReadinessTag.KNOWN && readiness.methods.google && device.appLinkVerified && device.externalBrowser);
  }

  public static boolean answerFresh(Answer cached, long now) {
    return now < cached.until && cached.until - now <= READY_TTL_MS;
  }

  public static boolean readinessComplete(Readiness readiness, GoogleMode googleMode) {
    if (readiness.tag != ReadinessTag.KNOWN) return false;
    CloudMethods m = readiness.methods;
    return m.email && m.sms && m.google && (googleMode == GoogleMode.BROWSER || (m.nativeSignIn && m.serverClientId));
  }

  public static boolean recheckDue(Answer cached, GoogleMode googleMode, long now) {
    return !readinessComplete(cached.readiness, googleMode) && (now >= cached.recheckAt || cached.recheckAt - now > RECHECK_MS);
  }

  public static StatusPlan onStatus(Answer cached, GoogleMode googleMode, long now, boolean retry) {
    boolean served = answerFresh(cached, now) && (readinessComplete(cached.readiness, googleMode) || !retry);
    return new StatusPlan(served, !served || recheckDue(cached, googleMode, now));
  }

  public static long passiveWait(int unchanged) {
    return 0 <= unchanged && unchanged < PASSIVE_WAITS_MS.length ? PASSIVE_WAITS_MS[unchanged] : 3_600_000L;
  }

  public static boolean passiveDue(Answer cached, GoogleMode googleMode, long now) {
    return !readinessComplete(cached.readiness, googleMode) && (now >= cached.passiveAt || cached.passiveAt - now > 3_600_000L);
  }

  public static boolean onLoad(Answer cached, GoogleMode googleMode, long now) {
    return !answerFresh(cached, now) || passiveDue(cached, googleMode, now);
  }

  public static boolean onResume(Answer cached, GoogleMode googleMode, long now, long statusAskedAt, boolean attemptActive) {
    return (attemptActive || (statusAskedAt > 0 && statusAskedAt <= now && now - statusAskedAt < RESUME_WINDOW_MS))
      && onLoad(cached, googleMode, now);
  }

  public static boolean anyReady(Readiness readiness) {
    return readiness.tag == ReadinessTag.KNOWN && (readiness.methods.email || readiness.methods.sms || readiness.methods.google);
  }

  public static Answer answerOf(Readiness readiness, long until, long recheckAt, long passiveAt, int unchanged, GoogleMode googleMode) {
    boolean complete = readinessComplete(readiness, googleMode);
    long recheck = complete ? until : Math.min(until, recheckAt);
    return new Answer(readiness, until, recheck,
      complete ? until : Math.min(until, Math.max(recheck, passiveAt)), Math.max(0, Math.min(unchanged, 4)));
  }

  public static Answer measureAnswer(Answer cached, CloudReading reading, GoogleMode googleMode, long now) {
    Readiness readiness = reading.tag == ReadingTag.METHODS_READ ? Readiness.known(reading.methods)
      : reading.tag == ReadingTag.CLIENT_UNREGISTERED ? Readiness.known(new CloudMethods(false, false, false, false, false))
      : Readiness.UNKNOWN;
    boolean repeated = !readinessComplete(readiness, googleMode) && readiness.equals(cached.readiness);
    int count = repeated ? cached.unchanged + 1 : 0;
    if (reading.tag == ReadingTag.NO_READING && answerFresh(cached, now)) {
      return answerOf(cached.readiness, cached.until, now + RECHECK_MS, now + passiveWait(cached.unchanged + 1), cached.unchanged + 1, googleMode);
    }
    if (reading.tag == ReadingTag.NO_READING) {
      return answerOf(Readiness.UNKNOWN, now + NOT_READY_TTL_MS, now + RECHECK_MS, now + RECHECK_MS, 0, googleMode);
    }
    return answerOf(readiness, now + (anyReady(readiness) ? READY_TTL_MS : NOT_READY_TTL_MS), now + RECHECK_MS, now + passiveWait(count), count, googleMode);
  }

  public static boolean announces(Readiness previous, Readiness measured) {
    return previous.tag != ReadinessTag.NOT_MEASURED && !previous.equals(measured);
  }

  public static ServiceOutcome serviceOutcome(boolean registered, int status, boolean wellFormed) {
    return !registered ? ServiceOutcome.SERVICE_UNKNOWN_ENVIRONMENT
      : status == 200 && wellFormed ? ServiceOutcome.SERVICE_SHOWN : ServiceOutcome.SERVICE_UNAVAILABLE;
  }
}
