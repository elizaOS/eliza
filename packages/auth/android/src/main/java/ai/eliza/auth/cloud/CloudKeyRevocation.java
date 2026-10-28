package ai.eliza.auth.cloud;

import java.net.HttpURLConnection;
import java.net.URI;

/**
 * Best-effort server-side revocation of a saved Cloud sign-in key: one DELETE of the presented key's
 * own self-revocation route, short timeouts, never retried, and every failure is ignored. Used for a
 * key a new sign-in replaced and for a confirmed local reset; the key also expires on its own.
 */
public final class CloudKeyRevocation {
 private CloudKeyRevocation() {}
 public static final int TIMEOUT_MS = 3000;
 public static String endpoint(CloudSignInEnvironment environment) { return environment.api() + CloudSignInRoutes.SELF_REVOCATION; }
 /** The bearer value of a saved Cloud credential, or null. Only a printable ASCII token is used. */
 public static String bearer(String token) {
  if (token == null || token.length() < 8 || token.length() > 16384) return null;
  for (int i = 0; i < token.length(); i++) if (token.charAt(i) <= 0x20 || token.charAt(i) >= 0x7f) return null;
  return token;
 }
 /** One attempt. Returns true only for a 2xx answer; never throws. */
 public static boolean revoke(CloudSignInConfig config, CloudSignInEnvironment environment, String token) {
  HttpURLConnection connection = null;
  try {
   String value = bearer(token); if (value == null) return false;
   URI url = URI.create(endpoint(environment));
   if (!CloudSignInRoutes.selfRevocation(config, url.getScheme(), url.getHost(), url.getPort(), url.getRawPath(), url.getRawQuery(), "DELETE", false)) return false;
   connection = (HttpURLConnection) url.toURL().openConnection();
   connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
   connection.setConnectTimeout(TIMEOUT_MS); connection.setReadTimeout(TIMEOUT_MS);
   connection.setRequestMethod("DELETE");
   connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Authorization", "Bearer " + value);
   int status = connection.getResponseCode();
   return status >= 200 && status < 300;
  } catch (Exception ignored) { return false; }
  finally { if (connection != null) connection.disconnect(); }
 }
}
