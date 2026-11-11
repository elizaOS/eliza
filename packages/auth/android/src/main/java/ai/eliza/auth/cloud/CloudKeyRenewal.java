package ai.eliza.auth.cloud;

import org.json.JSONObject;

/**
 * Pure policy for the silent renewal of a saved Cloud sign-in key (no Android classes, so it runs on
 * a plain JVM).
 *
 * The saved, acknowledged {@code eliza_mobile_} key asks Cloud for a new mobile authorization code
 * ({@link #PATH}); the code is exchanged and acknowledged through the ordinary mobile App Auth token
 * and ack routes. The new key replaces the saved one only after Cloud confirmed it, and the old key
 * is revoked only after the new one is saved. A refusal never removes the working key: the owner
 * signs in again when it expires.
 *
 * Nothing here logs, sends a request or touches storage.
 */
public final class CloudKeyRenewal {
 private CloudKeyRenewal() {}
 public static final String PATH = "/api/v1/app-auth/mobile/renew";
 private static final long DAY_MS = 24 * 60 * 60 * 1000L;
 /** A key with less than this left is renewed. */
 public static final long RENEW_BEFORE_MS = 10 * DAY_MS;
 /** At most one renewal request per saved key in this long, whatever its answer. */
 public static final long MIN_INTERVAL_MS = DAY_MS;
 /** The owner is warned only inside this window, and only when renewal is impossible or has failed. */
 public static final long WARN_BEFORE_MS = 3 * DAY_MS;

 /** Less than ten days left, or inside the last third of the key's life when its issue time is known. */
 public static boolean due(long now, long issuedAt, long expiresAt) {
  if (expiresAt <= now) return false;
  if (expiresAt - now < RENEW_BEFORE_MS) return true;
  return issuedAt > 0 && issuedAt <= now && issuedAt < expiresAt && expiresAt - now <= (expiresAt - issuedAt) / 3;
 }
 /** The daily limit. A last request recorded in the future (the clock moved back) limits nothing. */
 public static boolean allowed(long now, long attemptedAt) {
  return attemptedAt <= 0 || attemptedAt > now || now - attemptedAt >= MIN_INTERVAL_MS;
 }
 /** The expiry warning: only with fewer than three days left, and only when no renewal can help. */
 public static boolean warn(long now, long expiresAt, boolean impossibleOrFailed) {
  return impossibleOrFailed && expiresAt > now && expiresAt - now < WARN_BEFORE_MS;
 }

 /** What Cloud answered to the renewal request. */
 public enum Answer { CODE, SIGN_IN_REQUIRED, RETRY }
 /**
  * 200 carries a code. 401 (key invalid, expired, client disabled or registered again), 403 (user
  * inactive or the key left the user's organization) and 409 (the renewal window closed) need a full
  * sign-in. Everything else (429, 503, another status, no answer) may be asked again a day later.
  */
 public static Answer answer(int status) {
  if (status == 200) return Answer.CODE;
  if (status == 401 || status == 403 || status == 409) return Answer.SIGN_IN_REQUIRED;
  return Answer.RETRY;
 }

 /** The strict request body: the mobile PKCE binding of the App Auth connect route, without a flow. */
 public static JSONObject body(CloudSignInConfig config, CloudSignInEnvironment environment, String state, String challenge) throws Exception {
  if (!CloudSignInFlow.validState(state) || !CloudSignInFlow.validState(challenge)) throw new IllegalArgumentException("Invalid renewal proof");
  return new JSONObject().put("clientId", config.clientId).put("environment", environment.name).put("redirectUri", environment.callback())
   .put("state", state).put("codeChallenge", challenge).put("codeChallengeMethod", "S256").put("deviceName", config.deviceName);
 }

 /**
  * Non-secret renewal bookkeeping for one saved key, kept in plain preferences: the key's local
  * identity, when it was issued (0 when an older build saved it), when renewal was last asked and
  * what came of it. A record for another key says nothing about the saved one.
  */
 public static final class Record {
  public static final String NONE = "none", RETRY = "retry", REFUSED = "refused";
  public final String credentialId, result; public final long issuedAt, attemptedAt;
  public Record(String credentialId, long issuedAt, long attemptedAt, String result) {
   if (!CloudSignInFlow.validUuid(credentialId) || issuedAt < 0 || attemptedAt < 0 || !(NONE.equals(result) || RETRY.equals(result) || REFUSED.equals(result))) throw new IllegalArgumentException();
   this.credentialId = credentialId; this.issuedAt = issuedAt; this.attemptedAt = attemptedAt; this.result = result;
  }
  /** The record of this exact saved key, or an empty one for it. */
  public static Record of(Record stored, String credentialId) {
   return stored != null && stored.credentialId.equals(credentialId) ? stored : new Record(credentialId, 0, 0, NONE);
  }
  public Record attempted(long now, String outcome) { return new Record(credentialId, issuedAt, now, outcome); }
  /** The last request for this key did not renew it. */
  public boolean failed() { return !NONE.equals(result); }
  public String serialize() { return "v1|" + credentialId + "|" + issuedAt + "|" + attemptedAt + "|" + result; }
  public static Record parse(String value) {
   if (value == null) return null;
   String[] parts = value.split("\\|", -1);
   if (parts.length != 5 || !"v1".equals(parts[0])) return null;
   try { return new Record(parts[1], Long.parseLong(parts[2]), Long.parseLong(parts[3]), parts[4]); }
   catch (Exception invalid) { return null; }
  }
 }
}
