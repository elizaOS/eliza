package ai.eliza.auth.cloud;

/**
 * One Eliza Cloud deployment a native sign-in client may use. The host builds these from its own
 * deployment configuration; a product build registers only production, and a development build may
 * add staging. Every request the client makes goes to {@link #api()}; Steward returns a browser
 * sign-in to {@link #callback()}.
 */
public final class CloudSignInEnvironment {
 private static final String HOST = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+";
 /** Binding name sent to mobile App Auth ("production", "staging"). */
 public final String name;
 /** Cloud API host, HTTPS on the default port. */
 public final String apiHost;
 /** Web host that serves the app's verified return link. */
 public final String callbackHost;
 /** Steward tenant for this deployment. */
 public final String tenant;
 /** Public name of the deployment, shown in the authorization dialog. */
 public final String serviceName;
 /** Registered return path on the callback host, e.g. "/myapp/auth/callback". */
 public final String callbackPath;

 public CloudSignInEnvironment(String name, String apiHost, String callbackHost, String tenant, String serviceName, String callbackPath) {
  if (name == null || !name.matches("[a-z][a-z0-9-]{0,31}")) throw new IllegalArgumentException("Invalid Cloud environment name");
  if (apiHost == null || !apiHost.matches(HOST) || callbackHost == null || !callbackHost.matches(HOST)) throw new IllegalArgumentException("Invalid Cloud host");
  if (tenant == null || !tenant.matches("[a-z0-9][a-z0-9-]{0,63}")) throw new IllegalArgumentException("Invalid Steward tenant");
  if (serviceName == null || serviceName.trim().isEmpty() || serviceName.length() > 80 || !serviceName.matches("[^\\p{Cc}\\p{Cf}]+")) throw new IllegalArgumentException("Invalid service name");
  if (callbackPath == null || !callbackPath.matches("(/[A-Za-z0-9._~-]+)+")) throw new IllegalArgumentException("Invalid callback path");
  this.name = name; this.apiHost = apiHost; this.callbackHost = callbackHost; this.tenant = tenant; this.serviceName = serviceName.trim(); this.callbackPath = callbackPath;
 }
 public String api() { return "https://" + apiHost; }
 /** The verified return link; also the mobile App Auth binding string. */
 public String callback() { return "https://" + callbackHost + callbackPath; }
}
