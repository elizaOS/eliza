package ai.eliza.auth.cloud;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Pure policy for the native Eliza Cloud sign-in (no Android classes, so it runs on a plain JVM).
 *
 * Email and phone codes are typed into the app and verified natively (CloudEmailCode,
 * CloudSmsCode); Google uses the platform account picker with a server-bound nonce and PKCE.
 * Each Steward session is exchanged once for an `eliza_mobile_` Cloud key through the first-party
 * mobile App Auth routes (a second, independent state and PKCE pair), and the Steward session is
 * dropped. A browser return to the registered callback (from an older browser sign-in) follows the
 * shared callback contract parsed by {@link #parseCallback}.
 *
 * Nothing here logs, and nothing here reads or writes storage.
 */
public final class CloudSignInFlow {
 private CloudSignInFlow() {}
 /** A pending browser sign-in is single use and expires after ten minutes. */
 public static final long PENDING_TTL_MS = 10 * 60 * 1000L;
 /** Ack is idempotent and the token route re-reveals the same key until acknowledgeBy. */
 public static final int ACK_ATTEMPTS = 3;
 /** Steward rate-limits sends; the client adds a 30-second minimum and honors longer server deadlines. */
 public static final long RESEND_COOLDOWN_MS = 30 * 1000L;
 /** Wrong codes allowed per attempt before it ends; a new code starts a new attempt. */
 public static final int MAX_VERIFY_ATTEMPTS = 5;
 /** Errors a return may carry (shared callback contract errorAllowlist). */
 public static final java.util.Set<String> RETURN_ERRORS = java.util.Set.of("app_link_unverified", "mfa_required",
  "oauth_authentication_failed", "oauth_authorization_failed", "oauth_callback_incomplete", "oauth_identity_incomplete",
  "oauth_login_disabled", "oauth_profile_fetch_failed", "oauth_provider_mismatch", "oauth_provider_unavailable",
  "oauth_provider_unknown", "oauth_redirect_invalid", "oauth_state_consumed", "oauth_state_expired", "oauth_state_invalid",
  "oauth_token_exchange_failed");

 private static final SecureRandom RANDOM = new SecureRandom();
 private static String random(int bytes) {
  byte[] value = new byte[bytes]; RANDOM.nextBytes(value);
  return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
 }
 /** 48 random bytes: a 64-character RFC 7636 verifier. */
 public static String newVerifier() { return random(48); }
 /** 32 random bytes: a 43-character base64url state, also a valid mobile App Auth state. */
 public static String newState() { return random(32); }
 public static String s256(String verifier) {
  try {
   byte[] digest = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
   return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
  } catch (Exception unavailable) { throw new IllegalStateException("SHA-256 unavailable"); }
 }
 public static boolean validVerifier(String value) { return value != null && value.matches("[A-Za-z0-9._~-]{43,128}"); }
 public static boolean validState(String value) { return value != null && value.matches("[A-Za-z0-9_-]{43}"); }

 /** What a return to the callback URL carries (shared callback contract). */
 public enum ReturnKind { SUCCESS, ERROR, RETURN }
 /** A return to this environment's callback. SUCCESS sets code and state, ERROR sets error and state, RETURN sets neither. */
 public static final class Callback {
  public final ReturnKind kind; public final String state, code, error;
  Callback(ReturnKind kind, String state, String code, String error) { this.kind = kind; this.state = state; this.code = code; this.error = error; }
  public static final Callback NO_RESULT = new Callback(ReturnKind.RETURN, null, null, null);
 }
 /**
  * Shared callback contract:
  * - not this environment's callback (scheme, host, port, userinfo or exact path differ): null, ignored;
  * - SUCCESS: exactly {code,state} in the fragment and no query, as Steward's setRedirectFragment emits;
  * - ERROR: exactly {error,state} in the query or the fragment (not both), error from RETURN_ERRORS;
  * - RETURN: anything else on the callback, including no parameters (the fallback page's hand-off) and a
  *   code in the query. RETURN never carries a code.
  * Names appear once and values are non-empty, unescaped [A-Za-z0-9_.~-]; state is 43 base64url characters.
  */
 public static Callback parseCallback(String text, CloudSignInEnvironment environment) {
  if (text == null || text.length() > 8192) return null;
  URI uri;
  try { uri = new URI(text); } catch (Exception invalid) { return null; }
  if (!"https".equals(uri.getScheme()) || !environment.callbackHost.equals(uri.getRawAuthority()) || uri.getPort() != -1
   || uri.getRawUserInfo() != null || !environment.callbackPath.equals(uri.getRawPath())) return null;
  String fragment = emptyAsNull(uri.getRawFragment()), query = emptyAsNull(uri.getRawQuery());
  if (fragment == null && query == null) return Callback.NO_RESULT;
  if (fragment != null && query != null) return Callback.NO_RESULT;
  boolean fromFragment = fragment != null;
  Map<String, String> values = parameters(fromFragment ? fragment : query);
  if (values == null || values.size() != 2 || !validState(values.get("state"))) return Callback.NO_RESULT;
  String state = values.get("state");
  if (values.containsKey("code")) return fromFragment ? new Callback(ReturnKind.SUCCESS, state, values.get("code"), null) : Callback.NO_RESULT;
  String error = values.get("error");
  if (error != null && RETURN_ERRORS.contains(error)) return new Callback(ReturnKind.ERROR, state, null, error);
  return Callback.NO_RESULT;
 }
 private static String emptyAsNull(String value) { return value == null || value.isEmpty() ? null : value; }
 private static Map<String, String> parameters(String source) {
  Map<String, String> values = new LinkedHashMap<>();
  for (String part : source.split("&", -1)) {
   int equals = part.indexOf('=');
   if (equals <= 0) return null;
   String name = part.substring(0, equals), value = part.substring(equals + 1);
   if (!name.matches("[a-z_]{1,16}") || !value.matches("[A-Za-z0-9_.~-]{1,4096}")) return null;
   if (values.put(name, value) != null) return null;
  }
  return values;
 }

 /**
  * The one browser attempt this client waits for. Single use: burned by the return whose state
  * matches, by expiry, by an explicit cancel or by a new attempt. A return whose state does not match
  * leaves it alone (a foreign intent cannot cancel a sign-in), and so does a return without a result.
  */
 public static final class Pending {
  public final CloudSignInEnvironment environment; public final String state, verifier; public final long expiresAt;
  public Pending(CloudSignInEnvironment environment, String state, String verifier, long expiresAt) {
   if (environment == null || !validState(state) || !validVerifier(verifier)) throw new IllegalArgumentException();
   this.environment = environment; this.state = state; this.verifier = verifier; this.expiresAt = expiresAt;
  }
  public static Pending create(CloudSignInEnvironment environment, long now) { return new Pending(environment, newState(), newVerifier(), now + PENDING_TTL_MS); }
  public boolean expired(long now) { return now >= expiresAt; }
  /** Constant-time comparison of the returned state with this record's; expiry is checked separately. */
  public boolean sameState(Callback callback) {
   if (callback == null || callback.state == null) return false;
   return MessageDigest.isEqual(state.getBytes(StandardCharsets.US_ASCII), callback.state.getBytes(StandardCharsets.US_ASCII));
  }
  /** Same state and not expired. */
  public boolean matches(Callback callback, long now) { return !expired(now) && sameState(callback); }
  /** Encrypted at rest by the host's credential store. Every field is base64url or a number: '.' cannot occur. */
  public String serialize() { return "v1." + environment.name + "." + state + "." + verifier + "." + expiresAt; }
  /** A record for an environment this build does not admit is refused. */
  public static Pending parse(String value, CloudSignInConfig config) {
   if (value == null) return null;
   String[] parts = value.split("\\.", -1);
   if (parts.length != 5 || !"v1".equals(parts[0])) return null;
   try { return new Pending(config.environment(parts[1]), parts[2], parts[3], Long.parseLong(parts[4])); }
   catch (Exception invalid) { return null; }
  }
 }

 public static boolean validEmail(String value) {
  return value != null && value.length() <= 320 && value.matches("[^\\s@\\p{Cc}\\p{Cf}]+@[^\\s@\\p{Cc}\\p{Cf}]+\\.[^\\s@\\p{Cc}\\p{Cf}]+");
 }
 public static boolean validCode(String value) { return value != null && value.matches("[0-9]{6}"); }
 public static boolean validMobileSecret(String value) { return value != null && value.length() >= 20 && value.length() <= 512 && value.startsWith("eliza_mobile_") && value.matches("[\\x21-\\x7e]+"); }
 public static boolean validStewardToken(String value) { return value != null && value.length() >= 20 && value.length() <= 16384 && value.matches("[\\x21-\\x7e]+"); }
 public static boolean validUuid(String value) { return value != null && value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"); }

 /** Stable, non-secret failure codes shown to the renderer. Never derived from a response body. */
 public static String failureForStatus(String stage, int status) {
  if (status == 429) return "rate-limited";
  if (status == 410) return "expired";
  if (status == 403) return "account-check";
  if ((status == 400 || status == 401) && ("verify".equals(stage) || "mfa".equals(stage))) return "invalid-code";
  if ((status == 400 || status == 401) && "exchange".equals(stage)) return "expired";
  if (status >= 500 || status == 408) return "unavailable";
  return "rejected";
 }
 /** Native Google alone consumes these finite server response classifications.
  * Unknown error text never crosses the UI/log boundary. Legacy exchange/email/MFA keep their mapper. */
 public enum GoogleStage { CHALLENGE, VERIFY, LOCAL_DEADLINE }
 public static final class GoogleFailure {
  public final String code, reason;
  private GoogleFailure(String code, String reason) { this.code = code; this.reason = reason; }
 }
 public static GoogleFailure googleFailure(GoogleStage stage, int status, Object ok, Object error) {
  if (stage == null) throw new IllegalArgumentException("Google stage required");
  if (stage == GoogleStage.LOCAL_DEADLINE) return new GoogleFailure("expired", "local-deadline");
  if (status == 200) return new GoogleFailure(null, "response-received");
  if (Boolean.FALSE.equals(ok) && error instanceof String) {
   if (status == 400 && "A valid tenantId and clientId are required".equals(error)) return new GoogleFailure("invalid-request", "invalid-binding-input");
   if (status == 400 && "tenantId does not match X-Steward-Tenant".equals(error)) return new GoogleFailure("state-mismatch", "tenant-binding-mismatch");
   if (status == 404 && "App client not found or disabled".equals(error)) return new GoogleFailure("provider-refused", "client-unavailable");
   if (status == 503 && "Native Google sign-in is not configured for this app".equals(error)) return new GoogleFailure("unavailable", "native-google-unconfigured");
   if (status == 400 && stage == GoogleStage.CHALLENGE && "An S256 code challenge is required".equals(error)) return new GoogleFailure("invalid-request", "pkce-challenge-invalid");
   if (status == 400 && stage == GoogleStage.VERIFY && "challengeId, idToken and codeVerifier are required".equals(error)) return new GoogleFailure("invalid-request", "verification-input-invalid");
   if (status == 401 && stage == GoogleStage.VERIFY && "Sign-in challenge expired or was already used".equals(error)) return new GoogleFailure("expired", "challenge-unavailable");
   if (status == 401 && stage == GoogleStage.VERIFY && "Sign-in challenge does not match this request".equals(error)) return new GoogleFailure("state-mismatch", "challenge-request-mismatch");
   if (status == 401 && stage == GoogleStage.VERIFY && "Google identity could not be verified".equals(error)) return new GoogleFailure("provider-refused", "google-identity-unverified");
   if (status == 401 && stage == GoogleStage.VERIFY && "Sign-in challenge was already used".equals(error)) return new GoogleFailure("expired", "challenge-consumed");
   if (status == 401 && stage == GoogleStage.VERIFY && "Google identity token was already used or expired".equals(error)) return new GoogleFailure("provider-refused", "identity-proof-unavailable");
   if (status == 429 && "Too many sign-in attempts. Try again later.".equals(error)) return new GoogleFailure("rate-limited", "rate-limited");
  }
  if (status == 410) return new GoogleFailure("expired", "http-expired");
  if (status == 429) return new GoogleFailure("rate-limited", "http-rate-limited");
  if (status == 403) return new GoogleFailure("account-check", "http-account-check");
  if (status >= 500 || status == 408) return new GoogleFailure("unavailable", "http-unavailable");
  return new GoogleFailure("rejected", "unclassified-provider-refusal");
 }
 /** Fixed fields only: no attempt ID, body, provider text, token or callback. */
 public static String googleDiagnostic(GoogleStage stage, int status, GoogleFailure failure, long startedAt, long expiresAt, long now) {
  long elapsed = now >= startedAt && startedAt > 0 ? Math.min(86_400_000L, now - startedAt) : 0L;
  long remaining = expiresAt > 0 ? Math.max(-86_400_000L, Math.min(86_400_000L, expiresAt - now)) : 0L;
  // Derive reason again from fixed classification output, never accept caller text.
  String reason = failure.reason;
  return "stage=" + stage.name().toLowerCase(java.util.Locale.ROOT)
   + " status=" + (status >= 100 && status <= 599 ? status : 0)
   + " reason=" + reason + " elapsedMs=" + elapsed + " deadlineRemainingMs=" + remaining;
 }

 /** Ack is retried only for a transport failure or a retryable server status. */
 public static boolean ackRetryable(int status) { return status == -1 || status == 408 || status == 429 || status >= 500; }
 public static long ackBackoffMs(int attempt) { return attempt <= 0 ? 0 : Math.min(4000L, 1000L << (attempt - 1)); }
}
