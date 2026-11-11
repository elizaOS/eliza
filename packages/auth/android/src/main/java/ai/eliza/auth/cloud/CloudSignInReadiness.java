package ai.eliza.auth.cloud;

import java.util.List;
import java.util.Set;
import java.util.Locale;
import java.security.MessageDigest;

/**
 * Pure policy for the native sign-in readiness probe (no Android classes, so it runs on a plain JVM).
 *
 * Email requires Cloud's matching mobile App Auth registration and the email code route; SMS
 * requires the tenant to offer it without a captcha; native Google is enabled only when Steward
 * advertises googleNative. Each method is independent: one unavailable method never hides another.
 */
public final class CloudSignInReadiness {
 private CloudSignInReadiness() {}
 /** A ready method is cached for six hours; an answer with no ready method expires after ten minutes. */
 public static final long READY_TTL_MS = 6 * 60 * 60 * 1000L;
 public static final long NOT_READY_TTL_MS = 10 * 60 * 1000L;
 /**
  * A method that is not ready is measured again after this long, whatever the other methods answered:
  * Android can finish verifying the return link, or Cloud can enable a method, after the first probe.
  */
 public static final long METHOD_RECHECK_MS = 30 * 1000L;
 /**
  * Measurements nobody asked for (load, resume) of an answer that keeps coming back the same wait
  * longer each time. The sign-in screen asking (status) keeps METHOD_RECHECK_MS.
  */
 public static final long[] PASSIVE_RECHECK_MS = {30 * 1000L, 2 * 60 * 1000L, 10 * 60 * 1000L, 60 * 60 * 1000L};
 /** A resume measures only while a sign-in screen asked for status this recently, or an attempt is in progress. */
 public static final long RESUME_PROBE_WINDOW_MS = 10 * 60 * 1000L;
 public static boolean resumeProbe(long now, long statusAskedAt, boolean attemptActive) {
  return attemptActive || statusAskedAt > 0 && statusAskedAt <= now && now - statusAskedAt < RESUME_PROBE_WINDOW_MS;
 }
 /** Local checks of the return link after a probe found it unverified (no request is sent by them). */
 public static final long[] LINK_WATCH_MS = {3000, 7000, 15000, 30000, 60000, 120000};
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
 /**
  * A probe request that got no usable answer: a gateway or server error, a timeout answered for the
  * origin, or a rate limit. It says nothing about the method the request asks about, unlike a 4xx
  * refusal or a missing route. A request with no answer at all (no connection, a timeout) is the same.
  */
 public static boolean unanswered(int status) { return status >= 500 || status == 408 || status == 429; }
 /** The email code route exists: a bodiless request is refused as invalid, not as unknown. */
 public static boolean emailRoutePresent(int status) { return status >= 400 && status < 500 && status != 404 && status != 405; }

 /** A probe must redirect directly to Google's HTTPS account origin; no redirect is followed. */
 public static boolean redirectAllowed(int status, String location) {
  if ((status != 302 && status != 303 && status != 307) || location == null) return false;
  try {
   java.net.URI uri = new java.net.URI(location);
   return "https".equals(uri.getScheme()) && "accounts.google.com".equals(uri.getHost())
    && uri.getRawUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
  } catch (java.net.URISyntaxException invalid) { return false; }
 }
 public static final class Statement {
  final List<String> relations; final String namespace, packageName; final List<String> fingerprints;
  public Statement(List<String> relations, String namespace, String packageName, List<String> fingerprints) {
   this.relations = relations; this.namespace = namespace; this.packageName = packageName; this.fingerprints = fingerprints;
  }
 }
 public static String certificateFingerprint(byte[] certificate) {
  try {
   byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate);
   StringBuilder hex = new StringBuilder();
   for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02X", value & 0xff));
   return fingerprint(hex.toString());
  } catch (Exception unavailable) { return null; }
 }
 private static String fingerprint(String value) {
  if (value == null) return null;
  String hex = value.replace(":", "").toUpperCase(Locale.ROOT);
  if (!hex.matches("[0-9A-F]{64}")) return null;
  StringBuilder out = new StringBuilder();
  for (int i = 0; i < 64; i += 2) { if (i > 0) out.append(':'); out.append(hex, i, i + 2); }
  return out.toString();
 }
 public static boolean assetLinksGrant(List<Statement> statements, String packageName, Set<String> signers) {
  if (statements == null || packageName == null || signers == null || signers.isEmpty()) return false;
  for (Statement statement : statements) {
   if (statement == null || statement.relations == null || !statement.relations.contains("delegate_permission/common.handle_all_urls")
       || !"android_app".equals(statement.namespace) || !packageName.equals(statement.packageName) || statement.fingerprints == null) continue;
   for (String listed : statement.fingerprints) { String normalized = fingerprint(listed); if (normalized != null && signers.contains(normalized)) return true; }
  }
  return false;
 }

 /**
  * The probe's answer. Ready methods are trusted until `until`. A method that is not ready is measured
  * again from `recheckAt` when a sign-in screen asks, and from `passiveAt` (which grows with every
  * `unchanged` answer in a row) when nobody asked.
  */
 public static final class Result {
  public final boolean inApp, email, google, phone, methodsKnown; public final long until, recheckAt, passiveAt; public final int unchanged;
  public Result(boolean email, boolean google, boolean phone, long until) { this(email, google, phone, true, until); }
  public Result(boolean email, boolean google, boolean phone, boolean methodsKnown, long until) { this(email, google, phone, methodsKnown, until, until); }
  public Result(boolean email, boolean google, boolean phone, boolean methodsKnown, long until, long recheckAt) { this(email, google, phone, methodsKnown, until, recheckAt, recheckAt, 0); }
  public Result(boolean email, boolean google, boolean phone, boolean methodsKnown, long until, long recheckAt, long passiveAt, int unchanged) {
   this.methodsKnown = methodsKnown; this.email = email; this.google = google; this.phone = phone; this.inApp = email || google || phone; this.until = until;
   this.recheckAt = email && google && phone ? until : Math.min(until, recheckAt);
   this.passiveAt = email && google && phone ? until : Math.min(until, Math.max(this.recheckAt, passiveAt));
   this.unchanged = Math.max(0, Math.min(unchanged, PASSIVE_RECHECK_MS.length));
  }
  /** A fresh measurement: ready methods keep the long TTL, and any method that is not ready is due again after METHOD_RECHECK_MS. */
  public static Result measured(boolean email, boolean google, boolean phone, long now) {
   return new Result(email, google, phone, true, now + (email || google || phone ? READY_TTL_MS : NOT_READY_TTL_MS), now + METHOD_RECHECK_MS);
  }
  /**
   * A measurement in which a method's own request got no usable answer (`null`). That method keeps
   * what a still fresh `previous` answer said, and then the answer keeps that answer's TTL: nothing
   * unmeasured is trusted for longer than it was. With no fresh answer to keep, it is not ready and is
   * measured again after METHOD_RECHECK_MS. The other methods are the ones just measured.
   */
  public static Result measured(Boolean email, Boolean google, boolean phone, Result previous, long now) {
   if (email != null && google != null) return measured(email, google, phone, now);
   boolean kept = previous != null && previous.methodsKnown && previous.fresh(now);
   Result result = measured(email != null ? email : kept && previous.email, google != null ? google : kept && previous.google, phone, now);
   return kept ? new Result(result.email, result.google, result.phone, true, Math.min(previous.until, result.until), now + METHOD_RECHECK_MS) : result;
  }
  public static Result notReady(long now) { return new Result(false, false, false, false, now + NOT_READY_TTL_MS, now + METHOD_RECHECK_MS); }
  /** This measurement after `previous`: the same incomplete answer again waits longer before the next passive measurement. */
  public Result repeated(Result previous, long now) {
   if (complete() || !sameMethods(previous)) return this;
   int count = previous.unchanged + 1;
   return new Result(email, google, phone, methodsKnown, until, recheckAt, now + PASSIVE_RECHECK_MS[Math.min(count, PASSIVE_RECHECK_MS.length - 1)], count);
  }
  /**
   * A measurement over this answer got no result (no connection, a timeout). That says nothing about
   * the methods: they and their TTL stay, and only the next measurement is put off.
   */
  public Result unmeasured(long now) {
   int count = unchanged + 1;
   return new Result(email, google, phone, methodsKnown, until, now + METHOD_RECHECK_MS, now + PASSIVE_RECHECK_MS[Math.min(count, PASSIVE_RECHECK_MS.length - 1)], count);
  }
  /** A cache entry from the future (beyond the longest TTL) is not trusted. */
  public boolean fresh(long now) { return now < until && until - now <= READY_TTL_MS; }
  /** Every method is ready: nothing is left to measure again before `until`. */
  public boolean complete() { return email && google && phone; }
  /** A method is not ready and its short TTL has ended. A recheck time from the future is not trusted. */
  public boolean recheckDue(long now) { return !complete() && (now >= recheckAt || recheckAt - now > METHOD_RECHECK_MS); }
  /** As recheckDue, for a measurement nobody asked for: the growing wait has ended. */
  public boolean passiveDue(long now) { return !complete() && (now >= passiveAt || passiveAt - now > PASSIVE_RECHECK_MS[PASSIVE_RECHECK_MS.length - 1]); }
  public boolean sameMethods(Result other) { return other != null && email == other.email && google == other.google && phone == other.phone && methodsKnown == other.methodsKnown; }
  public String serialize() { return "v6-passive-recheck|" + email + "|" + google + "|" + phone + "|" + methodsKnown + "|" + until + "|" + recheckAt + "|" + passiveAt + "|" + unchanged; }
  public static Result parse(String value) {
   if (value == null) return null;
   String[] parts = value.split("\\|", -1);
   if (parts.length != 9 || !"v6-passive-recheck".equals(parts[0])) return null;
   for (int i = 1; i <= 4; i++) if (!"true".equals(parts[i]) && !"false".equals(parts[i])) return null;
   try { return new Result(Boolean.parseBoolean(parts[1]), Boolean.parseBoolean(parts[2]), Boolean.parseBoolean(parts[3]), Boolean.parseBoolean(parts[4]), Long.parseLong(parts[5]), Long.parseLong(parts[6]), Long.parseLong(parts[7]), Integer.parseInt(parts[8])); }
   catch (Exception invalid) { return null; }
  }
 }
}
