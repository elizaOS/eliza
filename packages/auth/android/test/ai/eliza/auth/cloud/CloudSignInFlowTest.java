package ai.eliza.auth.cloud;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONObject;

/** Plain-JVM checks of the native sign-in policy. No Android, network, storage or account. */
public final class CloudSignInFlowTest {
 private static int checks;
 private static void check(boolean condition, String message) { checks++; if (!condition) throw new AssertionError(message); }
 private static void refused(Runnable action, String message) {
  try { action.run(); check(false, message); } catch (IllegalArgumentException expected) { checks++; }
 }
 public static void main(String[] args) throws Exception {
  CloudSignInConfig product = TestRegistration.PRODUCT, development = TestRegistration.DEVELOPMENT;
  CloudSignInEnvironment production = TestRegistration.PRODUCTION, staging = TestRegistration.STAGING;

  // Registration: only the admitted environments, exact host/tenant/path shapes and installed names.
  check(product.environment("production") == production && product.defaultEnvironment() == production, "production admitted");
  check(development.environment("staging") == staging, "staging admitted by a development registration");
  for (String name : new String[]{"staging", "development", "", null}) refused(() -> product.environment(name), "refused environment " + name);
  check("https://eliza.app/example/auth/callback".equals(production.callback()) && "https://api.eliza.app".equals(production.api()), "callback and API");
  check("cloud-signin:v1:ack:production".equals(product.receiptSlot(production)) && "cloud:staging".equals(development.credentialSlot(staging)), "default installed slot names");
  refused(() -> new CloudSignInEnvironment("production", "api.eliza.app:8443", "eliza.app", "elizacloud", "Eliza Cloud", "/a"), "host with a port");
  refused(() -> new CloudSignInEnvironment("production", "API.eliza.app", "eliza.app", "elizacloud", "Eliza Cloud", "/a"), "upper-case host");
  refused(() -> new CloudSignInEnvironment("production", "api.eliza.app", "eliza.app", "elizacloud", "Eliza Cloud", "a/b"), "relative callback path");
  refused(() -> new CloudSignInEnvironment("production", "api.eliza.app", "eliza.app", "elizacloud", "Eliza\nCloud", "/a"), "control character in a name");
  refused(() -> TestRegistration.base().build(), "no environment");
  refused(() -> TestRegistration.base().environment(production).environment(production).build(), "duplicate environment");
  refused(() -> TestRegistration.base().clientId("Example App").environment(production).build(), "client id shape");
  refused(() -> TestRegistration.base().googleClientId("x").environment(production).build(), "Google client id shape");

  // PKCE and state: RFC 7636 shapes, fresh every time, S256 matches the verifier.
  Set<String> seen = new HashSet<>();
  for (int i = 0; i < 200; i++) {
   String verifier = CloudSignInFlow.newVerifier(), state = CloudSignInFlow.newState();
   check(verifier.length() == 64 && CloudSignInFlow.validVerifier(verifier), "64-character verifier");
   check(CloudSignInFlow.validState(state), "43-character state");
   check(seen.add(verifier) && seen.add(state), "never repeated");
  }
  check("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".equals(CloudSignInFlow.s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")), "RFC 7636 appendix B vector");

  // Callback: the shared contract vectors run in CloudSignInContractTest; these cover generated values.
  String state = CloudSignInFlow.newState();
  String code = Base64.getUrlEncoder().withoutPadding().encodeToString("synthetic-one-time-steward-code-0001".getBytes(StandardCharsets.US_ASCII));
  String base = "https://eliza.app/example/auth/callback";
  CloudSignInFlow.Callback ok = CloudSignInFlow.parseCallback(base + "#code=" + code + "&state=" + state, production);
  check(ok != null && ok.kind == CloudSignInFlow.ReturnKind.SUCCESS && code.equals(ok.code) && state.equals(ok.state) && ok.error == null, "valid return");
  CloudSignInFlow.Callback refused = CloudSignInFlow.parseCallback(base + "?error=oauth_authorization_failed&state=" + state, production);
  check(refused != null && refused.kind == CloudSignInFlow.ReturnKind.ERROR && refused.code == null && "oauth_authorization_failed".equals(refused.error), "Steward recovery link in the query");
  for (String url : new String[]{base, base + "?code=" + code + "&state=" + state, base + "#code=" + code + "&state=" + state + "&extra=1",
    base + "#code=" + code + "&code=" + code + "&state=" + state, base + "#code=a%2Fb&state=" + state, base + "#error=access_denied&state=" + state}) {
   CloudSignInFlow.Callback parsed = CloudSignInFlow.parseCallback(url, production);
   check(parsed != null && parsed.kind == CloudSignInFlow.ReturnKind.RETURN && parsed.code == null && parsed.state == null, "no result, never a code: " + url);
  }
  for (String url : new String[]{"http://eliza.app/example/auth/callback#code=" + code + "&state=" + state,
    "https://staging.eliza.app/example/auth/callback#code=" + code + "&state=" + state,
    "https://eliza.app:443/example/auth/callback#code=" + code + "&state=" + state,
    "https://eliza.app/example/auth/callback/#code=" + code + "&state=" + state, null})
   check(CloudSignInFlow.parseCallback(url, production) == null, "rejected return " + url);
  check(CloudSignInFlow.parseCallback("https://staging.eliza.app/example/auth/callback#code=" + code + "&state=" + state, staging).kind == CloudSignInFlow.ReturnKind.SUCCESS, "staging return for staging");

  // Pending record: single attempt, expires after ten minutes, constant-time state match.
  long now = 1_800_000_000_000L;
  CloudSignInFlow.Pending pending = CloudSignInFlow.Pending.create(production, now);
  check(pending.expiresAt == now + 10 * 60 * 1000L, "ten-minute pending record");
  CloudSignInFlow.Callback mine = CloudSignInFlow.parseCallback(base + "#code=" + code + "&state=" + pending.state, production);
  CloudSignInFlow.Callback other = CloudSignInFlow.parseCallback(base + "#code=" + code + "&state=" + CloudSignInFlow.newState(), production);
  check(pending.matches(mine, now + 1000) && !pending.matches(other, now + 1000) && !pending.matches(mine, pending.expiresAt) && !pending.matches(null, now), "state and expiry");
  check(pending.sameState(mine) && !pending.sameState(other) && !pending.sameState(CloudSignInFlow.Callback.NO_RESULT), "state compared before anything is burned");
  CloudSignInFlow.Pending restored = CloudSignInFlow.Pending.parse(pending.serialize(), product);
  check(restored != null && restored.state.equals(pending.state) && restored.verifier.equals(pending.verifier) && restored.expiresAt == pending.expiresAt && restored.environment == production, "encrypted-at-rest round trip");
  check(CloudSignInFlow.Pending.parse(CloudSignInFlow.Pending.create(staging, now).serialize(), product) == null, "a record for a deployment the build does not admit is refused");
  check(CloudSignInFlow.Pending.parse(CloudSignInFlow.Pending.create(staging, now).serialize(), development) != null, "a development build reads its staging record");
  for (String bad : new String[]{null, "", "v2.production." + pending.state + "." + pending.verifier + ".1", "v1.production.short." + pending.verifier + ".1", "v1.production." + pending.state + "." + pending.verifier + ".x", pending.serialize() + ".extra"})
   check(CloudSignInFlow.Pending.parse(bad, development) == null, "refused record " + bad);
  check(CloudSignInFlow.MAX_VERIFY_ATTEMPTS == 5 && CloudSignInFlow.RESEND_COOLDOWN_MS == 30_000L, "verify cap and send cooldown");

  // Inputs and responses.
  check(CloudSignInFlow.validEmail("owner@example.invalid") && !CloudSignInFlow.validEmail("owner@") && !CloudSignInFlow.validEmail("a b@example.invalid") && !CloudSignInFlow.validEmail("owner@example.invalid‮"), "email shape");
  check(CloudSignInFlow.validCode("012345") && !CloudSignInFlow.validCode("12345") && !CloudSignInFlow.validCode("1234567") && !CloudSignInFlow.validCode("12a456"), "six digits");
  check(CloudSignInFlow.validMobileSecret("eliza_mobile_" + "a".repeat(40)) && !CloudSignInFlow.validMobileSecret("eliza_" + "a".repeat(40)) && !CloudSignInFlow.validMobileSecret("eliza_mobile_\n" + "a".repeat(40)), "mobile key shape");
  check(CloudSignInFlow.validUuid("55555555-5555-4555-8555-555555555555") && !CloudSignInFlow.validUuid("x"), "credential id");

  // Failure mapping and the bounded acknowledgement retry.
  check("rate-limited".equals(CloudSignInFlow.failureForStatus("send", 429)), "429");
  check("invalid-code".equals(CloudSignInFlow.failureForStatus("verify", 401)) && "invalid-code".equals(CloudSignInFlow.failureForStatus("mfa", 400)), "wrong code");
  check("expired".equals(CloudSignInFlow.failureForStatus("exchange", 401)) && "expired".equals(CloudSignInFlow.failureForStatus("token", 410)), "used or expired code");
  check("account-check".equals(CloudSignInFlow.failureForStatus("verify", 403)) && "unavailable".equals(CloudSignInFlow.failureForStatus("connect", 503)) && "rejected".equals(CloudSignInFlow.failureForStatus("connect", 400)), "other statuses");
  check(CloudSignInFlow.ACK_ATTEMPTS == 3, "at most three acknowledgements");
  check(CloudSignInFlow.ackRetryable(-1) && CloudSignInFlow.ackRetryable(503) && CloudSignInFlow.ackRetryable(429) && !CloudSignInFlow.ackRetryable(400) && !CloudSignInFlow.ackRetryable(401) && !CloudSignInFlow.ackRetryable(410), "retry only transport and server failures");
  check(CloudSignInFlow.ackBackoffMs(0) == 0 && CloudSignInFlow.ackBackoffMs(1) == 1000 && CloudSignInFlow.ackBackoffMs(2) == 2000 && CloudSignInFlow.ackBackoffMs(9) == 4000, "bounded backoff");

  // Routes: exactly the fixed sign-in routes on an admitted API origin.
  for (String route : new String[]{CloudEmailCode.SEND_PATH, CloudEmailCode.VERIFY_PATH, CloudSmsCode.SEND_PATH, CloudSmsCode.VERIFY_PATH, "/steward/auth/oauth/exchange",
    "/steward/auth/oauth/google/native/challenge", "/steward/auth/oauth/google/native/verify", "/steward/auth/mfa/totp/complete", "/steward/auth/mfa/sms/complete",
    "/steward/auth/logout", "/api/v1/app-auth/connect", "/api/v1/app-auth/mobile/token", "/api/v1/app-auth/mobile/ack"}) {
   check(CloudSignInRoutes.route(route, "POST", true), "sign-in route " + route);
   check(!CloudSignInRoutes.route(route, "GET", false) && !CloudSignInRoutes.route(route, "POST", false), "POST with a body only " + route);
  }
  for (String route : new String[]{"/api/public/service", "/api/v1/app-auth/mobile/config", "/steward/auth/providers"})
   check(CloudSignInRoutes.route(route, "GET", false) && !CloudSignInRoutes.route(route, "GET", true) && !CloudSignInRoutes.route(route, "POST", true), "readiness read " + route);
  for (String route : new String[]{"/steward/auth/email/send", "/steward/auth/mfa/passkey/complete", "/steward/auth/email/code/send/", "/steward/auth/revoke",
    "/api/v1/app-auth/mobile/ack/x", "/api/auth/cli-session", "/steward/cloud-owner-phone/auth/sms/send", "/steward/auth/oauth/google/authorize", null})
   check(!CloudSignInRoutes.route(route, "POST", true) && !CloudSignInRoutes.route(route, "GET", false), "refused sign-in route " + route);
  check(CloudSignInRoutes.origin(product, "https", "api.eliza.app", -1) && CloudSignInRoutes.origin(product, "https", "api.eliza.app", 443), "production API");
  check(!CloudSignInRoutes.origin(product, "https", "api-staging.eliza.app", -1) && CloudSignInRoutes.origin(development, "https", "api-staging.eliza.app", -1), "staging only when admitted");
  check(!CloudSignInRoutes.origin(development, "http", "api.eliza.app", -1) && !CloudSignInRoutes.origin(product, "https", "eliza.app", -1) && !CloudSignInRoutes.origin(product, "https", "api.eliza.app", 8443) && !CloudSignInRoutes.origin(product, "https", null, -1), "nothing else");
  check(CloudSignInRoutes.selfRevocation(product, "https", "api.eliza.app", -1, "/api/v1/api-keys/current", null, "DELETE", false), "self-revocation");
  check(!CloudSignInRoutes.selfRevocation(product, "https", "api.eliza.app", -1, "/api/v1/api-keys/current", "x=1", "DELETE", false)
   && !CloudSignInRoutes.selfRevocation(product, "https", "api.eliza.app", -1, "/api/v1/api-keys/current", null, "DELETE", true)
   && !CloudSignInRoutes.selfRevocation(product, "https", "api.eliza.app", -1, "/api/v1/api-keys/other", null, "DELETE", false)
   && !CloudSignInRoutes.selfRevocation(product, "https", "api-staging.eliza.app", -1, "/api/v1/api-keys/current", null, "DELETE", false)
   && !CloudSignInRoutes.selfRevocation(product, "https", "api.eliza.app", -1, "/api/v1/api-keys/current", null, "POST", false), "self-revocation only exactly");
  check("https://api.eliza.app/api/v1/api-keys/current".equals(CloudKeyRevocation.endpoint(production)), "revocation endpoint");
  check(CloudKeyRevocation.bearer("eliza_mobile_abcdef") != null && CloudKeyRevocation.bearer("short") == null && CloudKeyRevocation.bearer("eliza mobile key") == null && CloudKeyRevocation.bearer(null) == null, "bearer shape");

  // Readiness: exact registration, independent methods and a bounded cache.
  check(CloudSignInReadiness.registered(200, true, "ai.example.signin", "production", "https://eliza.app/example/auth/callback", "S256", product, production), "registered client");
  check(!CloudSignInReadiness.registered(404, null, null, null, null, null, product, production)
   && !CloudSignInReadiness.registered(200, true, "ai.example.signin", "production", "https://staging.eliza.app/example/auth/callback", "S256", product, production)
   && !CloudSignInReadiness.registered(200, true, "ai.other.app", "production", "https://eliza.app/example/auth/callback", "S256", product, production)
   && !CloudSignInReadiness.registered(200, true, "ai.example.signin", "production", "https://eliza.app/example/auth/callback", "plain", product, production), "unregistered or another binding");
  check(CloudSignInReadiness.emailOffered(200, true, false, List.of("email_otp")) && !CloudSignInReadiness.emailOffered(200, true, true, List.of("email_otp")) && !CloudSignInReadiness.emailOffered(200, false, null, null), "email without a captcha");
  check(CloudSignInReadiness.emailRoutePresent(400) && CloudSignInReadiness.emailRoutePresent(429) && !CloudSignInReadiness.emailRoutePresent(404) && !CloudSignInReadiness.emailRoutePresent(405) && !CloudSignInReadiness.emailRoutePresent(503) && !CloudSignInReadiness.emailRoutePresent(-1), "email code route");
  long t = 1_800_000_000_000L;
  CloudSignInReadiness.Result ready = new CloudSignInReadiness.Result(true, true, false, t + CloudSignInReadiness.READY_TTL_MS);
  CloudSignInReadiness.Result restoredReady = CloudSignInReadiness.Result.parse(ready.serialize());
  check(restoredReady != null && restoredReady.inApp && restoredReady.google && !restoredReady.phone && restoredReady.until == ready.until && ready.fresh(t + 1) && !ready.fresh(ready.until), "cache round trip");
  CloudSignInReadiness.Result phoneOnly = new CloudSignInReadiness.Result(false, false, true, t + 1000);
  check(phoneOnly.inApp && !phoneOnly.email && !phoneOnly.google && CloudSignInReadiness.Result.parse(phoneOnly.serialize()).phone, "phone does not depend on email");
  check(CloudSignInReadiness.Result.notReady(t).until == t + CloudSignInReadiness.NOT_READY_TTL_MS && !CloudSignInReadiness.Result.notReady(t).methodsKnown, "not ready");
  check(CloudSignInReadiness.Result.parse("v2|true|true|1800000001000") == null && CloudSignInReadiness.Result.parse("v4-native-google|true|true|yes|true|1") == null && CloudSignInReadiness.Result.parse(null) == null, "old or malformed cache re-probes");
  check(!new CloudSignInReadiness.Result(true, true, false, t + 365L * 86400000L).fresh(t), "a cache entry from the future is not trusted");

  // Code adapters: tenant and client binding, PKCE, bounded expiry and resend deadlines.
  String verifier = CloudSignInFlow.newVerifier();
  JSONObject send = CloudEmailCode.sendBody(product, production, "owner@example.invalid", verifier);
  check(send.length() == 4 && "elizacloud".equals(send.getString("tenantId")) && "ai.example.signin".equals(send.getString("client"))
   && CloudSignInFlow.s256(verifier).equals(send.optJSONObject("pkce").getString("codeChallenge")) && "S256".equals(send.optJSONObject("pkce").getString("codeChallengeMethod")), "email send body");
  JSONObject verify = CloudEmailCode.verifyBody(development, staging, "owner@example.invalid", "123456", verifier);
  check(verify.length() == 5 && "elizacloud-staging".equals(verify.getString("tenantId")) && verifier.equals(verify.optJSONObject("pkce").getString("codeVerifier")), "email verify body");
  check(CloudEmailCode.expiresAt(null, t) == t + 600_000L && CloudEmailCode.expiresAt(t + 3_600_000L, t) == t + 900_000L && CloudEmailCode.expiresAt(t + 60_000L, t) == t + 60_000L, "code expiry bounded");
  check(CloudEmailCode.resendAt(null, null, t) == t + 30_000L && CloudEmailCode.resendAt(t + 90_000L, "5", t) == t + 90_000L && CloudEmailCode.resendAt(null, "120", t) == t + 120_000L
   && CloudEmailCode.resendAt("invalid", "not a date", t) == t + 30_000L && CloudEmailCode.resendAt(t - 1000, "0", t) == t + 30_000L, "a server deadline is never shortened");
  for (String phone : new String[]{null, "", "4155550100", "+01234567", "+1 4155550100", "+12345", "+1234567890123456"}) {
   check(!CloudSmsCode.validPhone(phone), "invalid phone " + phone);
   try { CloudSmsCode.sendBody(production, phone); check(false, "invalid phone accepted"); } catch (IllegalArgumentException expected) { checks++; }
  }
  JSONObject sms = CloudSmsCode.verifyBody(production, "+14155550100", "123456");
  check(sms.length() == 3 && "+14155550100".equals(sms.getString("phone")) && "elizacloud".equals(sms.getString("tenantId")) && "123456".equals(sms.getString("code")), "SMS body tenant-bound");
  for (String bad : new String[]{null, "12345", "abcdef"}) try { CloudSmsCode.verifyBody(production, "+14155550100", bad); check(false, "invalid code accepted"); } catch (IllegalArgumentException expected) { checks++; }
  check(CloudSmsCode.offered(200, true, null, null) && CloudSmsCode.offered(200, true, true, List.of("email_otp")) && !CloudSmsCode.offered(503, true, false, null)
   && !CloudSmsCode.offered(200, "true", false, null) && !CloudSmsCode.offered(200, true, true, null) && !CloudSmsCode.offered(200, true, true, List.of("sms_otp")), "SMS captcha admission");
  System.out.println("PASS cloud sign-in flow (" + checks + " checks)");
 }
}
