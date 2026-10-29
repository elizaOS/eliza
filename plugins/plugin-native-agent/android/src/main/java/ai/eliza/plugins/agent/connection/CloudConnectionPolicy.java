package ai.eliza.plugins.agent.connection;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Fixed route policy of a first-party renderer-to-Eliza-Cloud transport, outside the owner-bound
 * agent routes ({@link OwnerRoutePolicy}). The product injects its Eliza Cloud deployment hosts;
 * the reviewed Cloud API route set is shared. Pure, so it is tested without Android.
 *
 * <p>A production phone talks to its resident agent over the separate in-process agent bridge,
 * never through this transport, and does not pair with, restore or connect a remote or Cloud
 * agent. Every request a flag-off (no test mocks) build legitimately sends here goes to the Cloud
 * API, so the only admitted origin is exactly the production API host on the default HTTPS port.
 * Test-mocks builds keep every origin the URL validation admits (remote, Cloud and development
 * agents) and the staging hosts.
 */
public final class CloudConnectionPolicy {
  /** A product's Eliza Cloud deployment hosts: lower-case, exact, no port. */
  public static final class Hosts {
    public final String productionApi, stagingApi, productionWeb, stagingWeb, productionServices, stagingServices;
    /** Third-party hosts openExternal may also hand to the system browser (for example Google consent). */
    public final Set<String> externalProviders;

    public Hosts(
        String productionApi,
        String stagingApi,
        String productionWeb,
        String stagingWeb,
        String productionServices,
        String stagingServices,
        Set<String> externalProviders) {
      this.productionApi = productionApi;
      this.stagingApi = stagingApi;
      this.productionWeb = productionWeb;
      this.stagingWeb = stagingWeb;
      this.productionServices = productionServices;
      this.stagingServices = stagingServices;
      this.externalProviders = Collections.unmodifiableSet(new HashSet<>(externalProviders));
    }
  }

  private static final Set<String> MANAGED_POSTS =
      setOf(
          "/api/auth/cli-session",
          "/api/v1/eliza/google/connect/initiate",
          "/api/v1/eliza/google/disconnect",
          "/api/v1/eliza/google/gmail/inbox-v1/operations");
  private static final Set<String> MANAGED_READS =
      setOf(
          "/api/v1/user",
          "/api/v1/billing/limits",
          "/api/v1/subscription/entitlement",
          "/api/v1/subscription/entitlement-keys",
          "/api/v1/eliza/google/accounts",
          "/api/v1/eliza/google/status",
          "/api/v1/eliza/google/calendar/calendars",
          "/api/v1/eliza/google/calendar/feed",
          "/api/v1/eliza/google/gmail/search",
          "/api/v1/eliza/google/gmail/read");
  private static final String MAPS_DATA = "/api/v1/maps/(geocode|reverse|places/search|places/details|routes)";
  private static Set<String> setOf(String... values) {
    return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(values)));
  }

  /** The one key self-revocation route: the presented sign-in key revokes only itself. */
  public static final String SELF_REVOCATION_PATH = "/api/v1/api-keys/current";

  private final Hosts hosts;

  public CloudConnectionPolicy(Hosts hosts) {
    this.hosts = hosts;
  }

  public Hosts hosts() {
    return hosts;
  }

  /** Decoded path with repeated and trailing slashes removed, so spelling cannot dodge a route rule. */
  public static String canonical(String path) {
    if (path == null) return "";
    String value = path.replaceAll("/{2,}", "/");
    while (value.length() > 1 && value.endsWith("/")) value = value.substring(0, value.length() - 1);
    return value;
  }

  /**
   * Production phones run the resident agent and do not pair with a remote agent. The renderer
   * already refuses pairing; this keeps a renderer regression from sending a pairing code. Saved
   * remote credentials are untouched. Test-mocks builds keep pairing for development.
   */
  public boolean retiredPairing(String decodedPath, boolean testMocks) {
    return !testMocks && "/api/auth/pair".equals(canonical(decodedPath));
  }

  /** Origins this transport may contact: exactly the production Cloud API on the default HTTPS port. */
  public boolean admittedOrigin(String scheme, String host, int port, boolean testMocks) {
    if (testMocks) return true;
    return "https".equals(scheme) && hosts.productionApi.equals(host) && (port == -1 || port == 443);
  }

  /** Current managed Cloud APIs; new services need explicit route review. */
  public boolean managedService(String path, String query, String method, boolean hasBody, boolean testMocks) {
    if (testMocks) return true;
    if (path == null || path.contains("%") || path.contains("\\") || path.contains("//")) return false;
    if (calendarSync(path, query, method, hasBody)) return true;
    if ("DELETE".equals(method)) return SELF_REVOCATION_PATH.equals(path) && query == null && !hasBody;
    // Eliza Cloud Maps: queries and coordinates travel only in a JSON body; capabilities is a bare read.
    if ("POST".equals(method) && path.matches(MAPS_DATA)) return query == null && hasBody;
    if ("/api/v1/maps/capabilities".equals(path)) return "GET".equals(method) && query == null && !hasBody;
    // Subscription code redemption carries its code and idempotency key in the JSON body only.
    if ("POST".equals(method) && "/api/v1/subscription/redeem".equals(path)) return query == null && hasBody;
    if ("POST".equals(method))
      return query == null
          && (MANAGED_POSTS.contains(path)
              || path.matches("/api/v1/eliza/google/gmail/inbox-v1/operations/[A-Za-z0-9_-]{1,160}/dispatch"));
    if (!"GET".equals(method) || hasBody) return false;
    return path.matches("/api/auth/cli-session/[0-9a-fA-F-]{36}")
        || MANAGED_READS.contains(path)
        || path.matches("/api/v1/eliza/google/gmail/inbox-v1/(capabilities|thread|attachment|drafts|draft)")
        || path.matches("/api/v1/eliza/google/gmail/inbox-v1/operations/[A-Za-z0-9_-]{1,160}");
  }

  /** The versioned Google Calendar sync routes: queried reads/deletes, body-only writes. */
  public static boolean calendarSync(String path, String query, String method, boolean hasBody) {
    if ("/api/v1/eliza/google/calendar/sync-v1/capabilities".equals(path))
      return "GET".equals(method) && query != null && !query.isEmpty() && !hasBody;
    if (!"/api/v1/eliza/google/calendar/sync-v1/event".equals(path)) return false;
    if ("GET".equals(method) || "DELETE".equals(method)) return query != null && !query.isEmpty() && !hasBody;
    return ("POST".equals(method) || "PATCH".equals(method)) && query == null && hasBody;
  }

  /**
   * Hosts openExternal may hand to the system browser: the production web and services hosts and
   * the declared external providers; staging web/services only in test-mocks builds. HTTPS on the
   * default port only; exact hosts refuse lookalikes and trailing-dot spellings.
   */
  public boolean externalHost(String scheme, String host, int port, boolean testMocks) {
    if (!"https".equals(scheme) || host == null || (port != -1 && port != 443)) return false;
    String value = host.toLowerCase(Locale.ROOT);
    if (hosts.productionWeb.equals(value) || hosts.productionServices.equals(value) || hosts.externalProviders.contains(value))
      return true;
    return testMocks && (hosts.stagingWeb.equals(value) || hosts.stagingServices.equals(value));
  }

  /** The Cloud sign-in page, whose return is a browser handoff rather than a fire-and-forget open. */
  public boolean externalCliLogin(String host, String path, boolean testMocks) {
    String value = host == null ? "" : host.toLowerCase(Locale.ROOT);
    return (hosts.productionWeb.equals(value) || testMocks && hosts.stagingWeb.equals(value)) && "/auth/cli-login".equals(path);
  }

  /** The Cloud sign-in session poll (the claim the transport gates on foreground). */
  public boolean cliSessionPoll(String host, String path, String method) {
    return "GET".equals(method)
        && (hosts.productionApi.equals(host) || hosts.stagingApi.equals(host))
        && path != null
        && path.matches("/api/auth/cli-session/[0-9a-fA-F-]{36}");
  }

  /**
   * Request headers this transport forwards. Product builds talk only to the managed Cloud API,
   * which takes Accept, Content-Type and the sign-in Authorization. Device identity, capability and
   * phone-protocol headers declare the phone to a hosted or paired agent runtime and are admitted
   * only in test-mocks builds. Names must already be lower-case.
   */
  public static boolean admittedHeader(String name, boolean testMocks) {
    if (name == null) return false;
    if ("accept".equals(name) || "content-type".equals(name) || "authorization".equals(name)) return true;
    return testMocks
        && ("x-eliza-device-id".equals(name)
            || "x-eliza-device-key".equals(name)
            || "x-eliza-device-capabilities".equals(name)
            || "x-eliza-phone-protocol".equals(name));
  }

  /** Maps request identity is admitted only on the reviewed POST data routes. */
  public static boolean mapsRequestIdentity(String name, String value, String path, String method) {
    return "idempotency-key".equals(name)
        && value != null
        && value.matches("[A-Za-z0-9_-]{1,128}")
        && "POST".equals(method)
        && path != null
        && path.matches(MAPS_DATA);
  }

  /**
   * Cloud self-revocation: exactly DELETE https://&lt;production api&gt;/api/v1/api-keys/current on the
   * default port, without a query or body. The staging authority exists only in test-mocks builds.
   */
  public boolean cloudSelfRevocation(
      String scheme, String host, int port, String rawPath, String rawQuery, String method, boolean hasBody, boolean testMocks) {
    if (!"DELETE".equals(method) || hasBody || rawQuery != null || !"https".equals(scheme) || (port != -1 && port != 443))
      return false;
    if (!(hosts.productionApi.equals(host) || (testMocks && hosts.stagingApi.equals(host)))) return false;
    return SELF_REVOCATION_PATH.equals(rawPath);
  }
}
