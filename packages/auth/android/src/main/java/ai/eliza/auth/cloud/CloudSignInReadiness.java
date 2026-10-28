package ai.eliza.auth.cloud;

import java.util.List;

/**
 * Pure policy for the native sign-in readiness probe (no Android classes, so it runs on a plain JVM).
 *
 * Email requires Cloud's matching mobile App Auth registration and the email code route; SMS
 * requires the tenant to offer it without a captcha; native Google is enabled only when Steward
 * advertises googleNative. Each method is independent: one unavailable method never hides another.
 */
public final class CloudSignInReadiness {
 private CloudSignInReadiness() {}
 /** A ready answer is cached for six hours; an unavailable one is re-checked after ten minutes. */
 public static final long READY_TTL_MS = 6 * 60 * 60 * 1000L;
 public static final long NOT_READY_TTL_MS = 10 * 60 * 1000L;
 /** Each probe request is short; the renderer waits at most a few seconds before offering email alone. */
 public static final int REQUEST_TIMEOUT_MS = 4000;

 /** GET /api/v1/app-auth/mobile/config?clientId&environment&redirectUri answered for this exact binding. */
 public static boolean registered(int status, Object success, String clientId, String environment, String redirectUri, String method,
                                  CloudSignInConfig config, CloudSignInEnvironment expected) {
  return status == 200 && Boolean.TRUE.equals(success) && config.clientId.equals(clientId)
   && expected.name.equals(environment) && expected.callback().equals(redirectUri) && "S256".equals(method);
 }
 /** Steward offers email for the tenant, without a captcha this native client cannot answer. */
 public static boolean emailOffered(int status, Object email, Object captchaEnabled, List<String> captchaRequiredFor) {
  if (status != 200 || !Boolean.TRUE.equals(email)) return false;
  return !(Boolean.TRUE.equals(captchaEnabled) && captchaRequiredFor != null && (captchaRequiredFor.contains("email_otp") || captchaRequiredFor.contains("email")));
 }
 /** The email code route exists: a bodiless request is refused as invalid, not as unknown. */
 public static boolean emailRoutePresent(int status) { return status >= 400 && status < 500 && status != 404 && status != 405; }

 /** The probe's answer. */
 public static final class Result {
  public final boolean inApp, email, google, phone, methodsKnown; public final long until;
  public Result(boolean email, boolean google, boolean phone, long until) { this(email, google, phone, true, until); }
  public Result(boolean email, boolean google, boolean phone, boolean methodsKnown, long until) { this.methodsKnown = methodsKnown; this.email = email; this.google = google; this.phone = phone; this.inApp = email || google || phone; this.until = until; }
  public static Result notReady(long now) { return new Result(false, false, false, false, now + NOT_READY_TTL_MS); }
  /** A cache entry from the future (beyond the longest TTL) is not trusted. */
  public boolean fresh(long now) { return now < until && until - now <= READY_TTL_MS; }
  public String serialize() { return "v4-native-google|" + email + "|" + google + "|" + phone + "|" + methodsKnown + "|" + until; }
  public static Result parse(String value) {
   if (value == null) return null;
   String[] parts = value.split("\\|", -1);
   if (parts.length != 6 || !"v4-native-google".equals(parts[0])) return null;
   for (int i = 1; i <= 4; i++) if (!"true".equals(parts[i]) && !"false".equals(parts[i])) return null;
   try { return new Result(Boolean.parseBoolean(parts[1]), Boolean.parseBoolean(parts[2]), Boolean.parseBoolean(parts[3]), Boolean.parseBoolean(parts[4]), Long.parseLong(parts[5])); }
   catch (Exception invalid) { return null; }
  }
 }
}
