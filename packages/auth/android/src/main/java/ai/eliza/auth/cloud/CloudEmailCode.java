package ai.eliza.auth.cloud;

import org.json.JSONObject;

/**
 * The one adapter for Eliza Cloud's native email sign-in code: the code is sent to the address and
 * typed into the app; no magic link and no hosted Eliza Cloud page is involved.
 *
 * send:   POST {api}/steward/auth/email/code/send   {email, tenantId, client, pkce:{codeChallenge, codeChallengeMethod}}
 * verify: POST {api}/steward/auth/email/code/verify {email, code, tenantId, client, pkce:{codeVerifier}}
 *
 * The PKCE pair binds the verify call to the device that asked for the code; the verifier never
 * leaves native memory except in that verify body.
 */
public final class CloudEmailCode {
 private CloudEmailCode() {}
 public static final String SEND_PATH = "/steward/auth/email/code/send";
 public static final String VERIFY_PATH = "/steward/auth/email/code/verify";

 public static JSONObject sendBody(CloudSignInConfig config, CloudSignInEnvironment environment, String email, String verifier) throws Exception {
  return new JSONObject().put("email", email).put("tenantId", environment.tenant).put("client", config.clientId)
   .put("pkce", new JSONObject().put("codeChallenge", CloudSignInFlow.s256(verifier)).put("codeChallengeMethod", "S256"));
 }
 public static JSONObject verifyBody(CloudSignInConfig config, CloudSignInEnvironment environment, String email, String code, String verifier) throws Exception {
  return new JSONObject().put("email", email).put("code", code).put("tenantId", environment.tenant).put("client", config.clientId)
   .put("pkce", new JSONObject().put("codeVerifier", verifier));
 }
 /** When the code stops working: the server's expiresAt when present, never later than 15 minutes, 10 minutes when absent. */
 public static long expiresAt(Object reported, long now) {
  long value = reported instanceof Number ? ((Number) reported).longValue() : 0;
  if (value == 0 && reported instanceof String) try { value = java.time.Instant.parse((String) reported).toEpochMilli(); } catch (Exception invalid) { value = 0; }
  if (value <= 0) return now + 10 * 60 * 1000L;
  return Math.min(value, now + 15 * 60 * 1000L);
 }
 /** Never shorten a server resend timestamp or Retry-After header. No timer sends automatically. */
 public static long resendAt(Object reported, String retryAfter, long now) {
  long result = now + CloudSignInFlow.RESEND_COOLDOWN_MS;
  long timestamp = reported instanceof Number ? ((Number) reported).longValue() : 0;
  if (reported instanceof String) try { timestamp = java.time.Instant.parse((String) reported).toEpochMilli(); } catch (Exception invalid) { /* Use the local minimum. */ }
  result = Math.max(result, timestamp);
  if (retryAfter != null) try {
   String value = retryAfter.trim();
   long deadline = value.matches("[0-9]{1,9}") ? now + Long.parseLong(value) * 1000L
    : java.time.ZonedDateTime.parse(value, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli();
   result = Math.max(result, deadline);
  } catch (Exception invalid) { /* A malformed header cannot shorten the local or server deadline. */ }
  return result;
 }
}
