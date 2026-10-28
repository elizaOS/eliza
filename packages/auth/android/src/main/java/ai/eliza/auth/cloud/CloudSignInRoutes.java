package ai.eliza.auth.cloud;

import java.util.Set;

/**
 * The fixed Cloud routes the native sign-in client sends, built from URLs it makes itself. A
 * renderer transport must never admit them: no Steward session, authorization code or PKCE
 * verifier crosses the bridge. Pure so it is tested without Android.
 */
public final class CloudSignInRoutes {
 private CloudSignInRoutes() {}
 /** Readiness reads: service document, App Auth registration and Steward providers. */
 public static final Set<String> READS = Set.of("/api/public/service", "/api/v1/app-auth/mobile/config", "/steward/auth/providers");
 public static final Set<String> WRITES = Set.of(CloudSmsCode.SEND_PATH, CloudSmsCode.VERIFY_PATH, CloudEmailCode.SEND_PATH, CloudEmailCode.VERIFY_PATH,
  "/steward/auth/oauth/exchange", "/steward/auth/oauth/google/native/challenge", "/steward/auth/oauth/google/native/verify",
  "/steward/auth/mfa/totp/complete", "/steward/auth/mfa/sms/complete", "/steward/auth/logout",
  "/api/v1/app-auth/connect", "/api/v1/app-auth/mobile/token", "/api/v1/app-auth/mobile/ack");
 public static final String SELF_REVOCATION = "/api/v1/api-keys/current";

 /** GETs carry no body; every POST carries a JSON body. */
 public static boolean route(String path, String method, boolean hasBody) {
  if (path == null) return false;
  if ("GET".equals(method)) return !hasBody && READS.contains(path);
  return "POST".equals(method) && hasBody && WRITES.contains(path);
 }
 /** Exactly an admitted environment's Cloud API, HTTPS on the default port. */
 public static boolean origin(CloudSignInConfig config, String scheme, String host, int port) {
  if (!"https".equals(scheme) || (port != -1 && port != 443) || host == null) return false;
  for (CloudSignInEnvironment environment : config.environments()) if (environment.apiHost.equals(host)) return true;
  return false;
 }
 /** Self-revocation: the presented key revokes only itself, with no query or body. */
 public static boolean selfRevocation(CloudSignInConfig config, String scheme, String host, int port, String rawPath, String rawQuery, String method, boolean hasBody) {
  return "DELETE".equals(method) && !hasBody && rawQuery == null && SELF_REVOCATION.equals(rawPath) && origin(config, scheme, host, port);
 }
}
