package ai.eliza.auth.cloud;

import org.json.JSONObject;

/**
 * Pure policy for the silent renewal of a saved Cloud sign-in key (no Android classes, so it runs on
 * a plain JVM).
 *
 * The saved, acknowledged {@code eliza_mobile_} key asks Cloud for a new mobile authorization code
 * ({@link #PATH}); the code is exchanged and acknowledged through the ordinary mobile App Auth token
 * and ack routes. The successor secret and proof are durably staged before acknowledgement. The
 * new key replaces the selected one only after Cloud confirmed it, and the old key
 * is revoked only after the new one is saved. A refusal never removes the working key: the owner
 * signs in again when it expires.
 *
 * Cloud's rules for the keys of one sign-in bound what this client may send:
 * <ul>
 * <li>A key that revokes itself ends the whole sign-in, unless it names its confirmed successor
 * ({@link CloudKeyRevocation#RENEWED_CREDENTIAL_HEADER}). So the replaced key is revoked only with
 * that name, and a new key that was not saved is never revoked while the key it was renewed from is
 * still the saved one: that request would end the saved key.</li>
 * <li>A key whose successor Cloud confirmed must not ask for renewal again: Cloud takes that as two
 * holders and ends the sign-in. So once a confirmation may have reached Cloud, the saved key is not
 * presented again while a successor receipt exists. An acknowledgement refusal does not prove that
 * another in-flight acknowledgement cannot still commit.</li>
 * </ul>
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
  * sign-in. Other failures defer completion. A dispatched request retains its exclusive claim until
  * it advances to a successor receipt or the owner signs in again.
  */
 public static Answer answer(int status) {
  if (status == 200) return Answer.CODE;
  if (status == 401 || status == 403 || status == 409) return Answer.SIGN_IN_REQUIRED;
  return Answer.RETRY;
 }
 /**
  * 401 to a renewal request is Cloud refusing the presented key itself (revoked, ended with its
  * sign-in, expired, or its client disabled): unlike 403 and 409, the saved key does not keep working.
  */
 public static boolean keyRefused(int status) { return status == 401; }

 /**
  * An exclusive pre-network claim in the same encrypted receipt slot. It cannot be stolen on a
  * timeout: another live host might be paused immediately before dispatching its predecessor key.
  * Only the exact in-flight owner can replace it with a full successor receipt, or remove it before
  * dispatch. Once dispatched it remains on every uncertain outcome.
  */
 public static final class Request {
  public static final String KIND = "mobile-key-renewal-request-v1";
  public final String raw, generation, predecessor;
  public final long attemptedAt;
  private Request(String raw, JSONObject value, CloudSignInConfig config, CloudSignInEnvironment environment) throws Exception {
   this.raw = raw;
   generation = value.getString("generation"); predecessor = value.getString("predecessor");
   attemptedAt = value.getLong("attemptedAt");
   JSONObject before = new JSONObject(predecessor);
   if (!isRequest(value) || !CloudSignInFlow.Pending.validGeneration(generation)
     || !CloudSignInFlow.validUuid(value.optString("requestId", null)) || attemptedAt <= 0
     || !config.clientId.equals(value.optString("clientId", null))
     || !environment.name.equals(value.optString("environment", null))
     || !environment.callback().equals(value.optString("redirectUri", null))
     || !CloudSignInFlow.validUuid(before.optString("credentialId", null))
     || !CloudSignInFlow.validMobileSecret(before.optString("token", null))
     || Receipt.time(before.opt("expiresAt")) <= 0) throw new IllegalArgumentException("Invalid renewal request claim");
  }
  public static boolean isRequest(JSONObject value) { return KIND.equals(value.optString("kind", null)); }
  public static Request parse(String raw, CloudSignInConfig config, CloudSignInEnvironment environment) throws Exception {
   return new Request(raw, new JSONObject(raw), config, environment);
  }
  public static Request create(CloudSignInConfig config, CloudSignInEnvironment environment, String generation, String predecessor, long now) throws Exception {
   String raw = new JSONObject().put("kind", KIND).put("generation", generation).put("predecessor", predecessor)
    .put("requestId", java.util.UUID.randomUUID().toString()).put("attemptedAt", now)
    .put("clientId", config.clientId).put("environment", environment.name).put("redirectUri", environment.callback()).toString();
   return parse(raw, config, environment);
  }
  public boolean matchesPredecessor(String value) { return Receipt.sameCredential(predecessor, value); }
 }

 /**
  * A successor's encrypted acknowledgement receipt, in the existing native receipt slot. The
  * selected predecessor is kept until Cloud confirms the successor. The receipt retains everything
  * needed to retry that exact acknowledgement and publication after a process restart.
  */
 public static final class Receipt {
  public static final String KIND = "mobile-key-renewal-v1";
  public final String raw, generation, predecessor, successor;
  public final String previousToken, credentialId, secret, installedId;
  public final long previousExpiresAt, expiresAt, acknowledgeBy;
  public final boolean confirmed;
  private final String proof;

  private Receipt(String raw, JSONObject value, CloudSignInConfig config, CloudSignInEnvironment environment) throws Exception {
   if (!KIND.equals(value.optString("kind", null))) throw new IllegalArgumentException("Not a renewal receipt");
   this.raw = raw;
   generation = value.getString("generation");
   predecessor = value.getString("predecessor");
   successor = value.getString("successor");
   JSONObject before = new JSONObject(predecessor), after = new JSONObject(successor), binding = value.optJSONObject("proof");
   previousToken = before.getString("token");
   previousExpiresAt = time(before.opt("expiresAt"));
   credentialId = after.getString("serverCredentialId");
   secret = after.getString("token");
   installedId = after.getString("credentialId");
   expiresAt = time(after.opt("expiresAt"));
   acknowledgeBy = value.getLong("acknowledgeBy");
   if (!(value.opt("confirmed") instanceof Boolean)) throw new IllegalArgumentException("Invalid renewal receipt state");
   confirmed = Boolean.TRUE.equals(value.opt("confirmed"));
   if (!CloudSignInFlow.Pending.validGeneration(generation)
    || !CloudSignInFlow.validUuid(before.optString("credentialId", null))
    || !CloudSignInFlow.validMobileSecret(previousToken) || previousExpiresAt <= 0
    || !CloudSignInFlow.validUuid(credentialId) || !CloudSignInFlow.validUuid(installedId)
    || !CloudSignInFlow.validMobileSecret(secret) || secret.equals(previousToken)
    || expiresAt <= previousExpiresAt || acknowledgeBy <= 0 || binding == null
    || !config.clientId.equals(binding.optString("clientId", null))
    || !environment.name.equals(binding.optString("environment", null))
    || !environment.callback().equals(binding.optString("redirectUri", null))
    || !CloudSignInFlow.validState(binding.optString("state", null))
    || !CloudSignInFlow.validVerifier(binding.optString("codeVerifier", null))
    || !binding.optString("code", "").matches("emac_[0-9a-f]{64}")
    || !credentialId.equals(binding.optString("credentialId", null))
    || !secret.equals(binding.optString("secret", null)))
    throw new IllegalArgumentException("Invalid renewal receipt");
   proof = binding.toString();
  }

  public static boolean isRenewal(JSONObject value) { return KIND.equals(value.optString("kind", null)); }
  public static Receipt parse(String raw, CloudSignInConfig config, CloudSignInEnvironment environment) throws Exception {
   return new Receipt(raw, new JSONObject(raw), config, environment);
  }
  public static Receipt create(CloudSignInConfig config, CloudSignInEnvironment environment, String generation,
    String predecessor, JSONObject binding, String credentialId, String secret, long expiresAt, long acknowledgeBy) throws Exception {
   JSONObject successor = new JSONObject().put("credentialId", java.util.UUID.randomUUID().toString())
    .put("token", secret).put("expiresAt", expiresAt).put("serverCredentialId", credentialId);
   JSONObject proof = new JSONObject(binding.toString()).put("credentialId", credentialId).put("secret", secret);
   String raw = new JSONObject().put("kind", KIND).put("generation", generation).put("predecessor", predecessor)
    .put("successor", successor.toString()).put("proof", proof).put("acknowledgeBy", acknowledgeBy).put("confirmed", false).toString();
   return parse(raw, config, environment);
  }
  public JSONObject proof() throws Exception { return new JSONObject(proof); }
  public String confirmedRecord() throws Exception { return new JSONObject(raw).put("confirmed", true).toString(); }
  public boolean matchesPredecessor(String value) { return sameCredential(predecessor, value); }
  public boolean matchesSuccessor(String value) { return sameCredential(successor, value); }
  private static boolean sameCredential(String left, String right) {
   if (left == null || right == null) return false;
   try {
    JSONObject a = new JSONObject(left), b = new JSONObject(right);
    return a.getString("credentialId").equals(b.getString("credentialId"))
     && a.getString("token").equals(b.getString("token"))
     && a.optString("serverCredentialId", "").equals(b.optString("serverCredentialId", ""))
     && time(a.opt("expiresAt")) == time(b.opt("expiresAt"));
   } catch (Exception invalid) { return false; }
  }
  private static long time(Object value) {
   if (value instanceof Number) return ((Number) value).longValue();
   if (value instanceof String) try { return java.time.Instant.parse((String) value).toEpochMilli(); } catch (Exception invalid) { return 0; }
   return 0;
  }
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
  *
  * The encrypted request/receipt is the custody and exclusion authority; this plain record only
  * limits requests and supports older builds' `confirming` markers. `rejected`: Cloud
  * answered the renewal request of this key with 401.
  */
 public static final class Record {
  public static final String NONE = "none", RETRY = "retry", REFUSED = "refused", CONFIRMING = "confirming", REJECTED = "rejected";
  public final String credentialId, result; public final long issuedAt, attemptedAt;
  public Record(String credentialId, long issuedAt, long attemptedAt, String result) {
   if (!CloudSignInFlow.validUuid(credentialId) || issuedAt < 0 || attemptedAt < 0 || !(NONE.equals(result) || RETRY.equals(result) || REFUSED.equals(result) || CONFIRMING.equals(result) || REJECTED.equals(result))) throw new IllegalArgumentException();
   this.credentialId = credentialId; this.issuedAt = issuedAt; this.attemptedAt = attemptedAt; this.result = result;
  }
  /** The record of this exact saved key, or an empty one for it. */
  public static Record of(Record stored, String credentialId) {
   return stored != null && stored.credentialId.equals(credentialId) ? stored : new Record(credentialId, 0, 0, NONE);
  }
  public Record attempted(long now, String outcome) { return new Record(credentialId, issuedAt, now, outcome); }
  /** The last request for this key did not renew it. */
  public boolean failed() { return !NONE.equals(result); }
  /** This key is never presented for renewal again: Cloud may hold a confirmed successor of it. */
  public boolean spent() { return CONFIRMING.equals(result); }
  /** Cloud will not renew this key; the owner signs in again. */
  public boolean signInRequired() { return REFUSED.equals(result) || REJECTED.equals(result) || CONFIRMING.equals(result); }
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
