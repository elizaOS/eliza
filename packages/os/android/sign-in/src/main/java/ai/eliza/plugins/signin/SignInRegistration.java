// spec/os/signIn/readiness.md, "Story: Show only the methods the cloud is ready for"; spec/os/signIn/readiness.md, "Story: Read the service's own terms"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.ReadinessPolicy.GoogleMode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * What the host registers with the cloud for native sign-in, read once at plugin load. Anything
 * incomplete or ambiguous is refused with {@link Refused}; no default and no hosted page replaces it.
 * B4 (sign-in), B6 (browser return) and B7 (cloud requests) read this and nothing else about the host.
 */
public final class SignInRegistration {
  /** The registration is incomplete or ambiguous. */
  public static final class Refused extends IllegalArgumentException {
    public Refused(String message) { super(message); }
  }

  /** One registered cloud: the API origin, the verified App Link host and the redirect Android returns through. */
  public static final class Environment {
    public final String name, apiOrigin, appLinkHost, redirectUri;
    private Environment(String name, String apiOrigin, String appLinkHost, String redirectUri) {
      this.name = name; this.apiOrigin = apiOrigin; this.appLinkHost = appLinkHost; this.redirectUri = redirectUri;
    }
  }

  /** One cloud route the host lets {@code ElizaCloud} send; {@code *} in a path matches exactly one segment. */
  public static final class Route {
    public final String method, path;
    private Route(String method, String path) { this.method = method; this.path = path; }
    public boolean admits(String requestMethod, String requestPath) {
      if (!method.equals(requestMethod)) return false;
      String[] want = path.split("/", -1), have = requestPath.split("/", -1);
      if (want.length != have.length) return false;
      for (int i = 0; i < want.length; i++) {
        if (want[i].equals("*") ? have[i].isEmpty() : !want[i].equals(have[i])) return false;
      }
      return true;
    }
  }

  public static final String PRODUCTION = "production";
  private static final Pattern CLIENT_ID = Pattern.compile("[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+");
  private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9-]{0,31}");
  private static final Pattern HOST = Pattern.compile("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+");
  private static final Pattern PATH = Pattern.compile("(/[A-Za-z0-9._~-]+)+");
  private static final Pattern SCOPE = Pattern.compile("[A-Za-z0-9._:/-]{1,200}");
  private static final Pattern ROUTE_PATH = Pattern.compile("(/([A-Za-z0-9._~-]+|\\*))+");
  private static final List<String> METHODS = List.of("GET", "POST", "PUT", "PATCH", "DELETE");

  public final String clientId;
  public final boolean testEnvironmentsEnabled;
  public final GoogleMode googleMode;
  private final Map<String, Environment> environments;
  private final List<String> googleScopes;
  private final List<Route> routes;

  private SignInRegistration(String clientId, boolean testEnvironmentsEnabled, GoogleMode googleMode,
      Map<String, Environment> environments, List<String> googleScopes, List<Route> routes) {
    this.clientId = clientId; this.testEnvironmentsEnabled = testEnvironmentsEnabled; this.googleMode = googleMode;
    this.environments = environments; this.googleScopes = googleScopes; this.routes = routes;
  }

  /** The registered cloud named {@code name}; {@code null} (or absent) names production. Unknown: {@code null}. */
  public Environment environment(String name) { return environments.get(name == null ? PRODUCTION : name); }
  public Environment production() { return environments.get(PRODUCTION); }
  public List<Environment> environments() { return List.copyOf(environments.values()); }
  public List<String> googleScopes() { return googleScopes; }
  public List<Route> routes() { return routes; }

  public boolean admitsRoute(String method, String path) {
    for (Route route : routes) if (route.admits(method, path)) return true;
    return false;
  }

  /**
   * Parses the host's registration from plain maps and lists, as the plugin reads them from its
   * configuration: {clientId, testEnvironments?, googleMode, googleScopes?, environments: [{name,
   * apiOrigin, appLinkHost, redirectPath}], routes?: [{method, path}]}. The redirect is always
   * https://appLinkHost + redirectPath, so a redirect can never leave its own App Link host.
   */
  public static SignInRegistration parse(Map<String, ?> config) {
    String clientId = text(config, "clientId");
    if (!CLIENT_ID.matcher(clientId).matches()) throw new Refused("clientId");
    Object testFlag = config.get("testEnvironments");
    if (testFlag != null && !(testFlag instanceof Boolean)) throw new Refused("testEnvironments");
    boolean tests = Boolean.TRUE.equals(testFlag);
    GoogleMode mode = switch (text(config, "googleMode")) {
      case "picker" -> GoogleMode.PICKER;
      case "browser" -> GoogleMode.BROWSER;
      default -> throw new Refused("googleMode");
    };
    Map<String, Environment> environments = new LinkedHashMap<>();
    List<String> hosts = new ArrayList<>();
    for (Object row : list(config, "environments", true)) {
      Map<String, ?> entry = map(row, "environments");
      String name = text(entry, "name");
      if (!NAME.matcher(name).matches()) throw new Refused("environment name");
      if (!name.equals(PRODUCTION) && !tests) throw new Refused("environment " + name + " needs testEnvironments");
      String api = text(entry, "apiOrigin"), appLink = text(entry, "appLinkHost"), path = text(entry, "redirectPath");
      if (!api.startsWith("https://") || !HOST.matcher(api.substring("https://".length())).matches()) throw new Refused("apiOrigin");
      if (!HOST.matcher(appLink).matches() || !PATH.matcher(path).matches()) throw new Refused("redirect");
      if (environments.containsKey(name)) throw new Refused("duplicate environment " + name);
      if (hosts.contains(api)) throw new Refused("duplicate apiOrigin " + api);
      hosts.add(api);
      environments.put(name, new Environment(name, api, appLink, "https://" + appLink + path));
    }
    if (!environments.containsKey(PRODUCTION)) throw new Refused("production environment");
    List<String> scopes = new ArrayList<>();
    for (Object scope : list(config, "googleScopes", false)) {
      if (!(scope instanceof String s) || !SCOPE.matcher(s).matches() || scopes.contains(s)) throw new Refused("googleScopes");
      scopes.add(s);
    }
    List<Route> routes = new ArrayList<>();
    for (Object row : list(config, "routes", false)) {
      Map<String, ?> entry = map(row, "routes");
      String method = text(entry, "method"), path = text(entry, "path");
      if (!METHODS.contains(method) || !path.startsWith("/api/") || !ROUTE_PATH.matcher(path).matches()) throw new Refused("route " + method + " " + path);
      routes.add(new Route(method, path));
    }
    return new SignInRegistration(clientId, tests, mode, Collections.unmodifiableMap(environments),
      List.copyOf(scopes), List.copyOf(routes));
  }

  private static String text(Map<String, ?> source, String key) {
    return source.get(key) instanceof String s && !s.isEmpty() ? s : refuse(key);
  }

  private static String refuse(String key) { throw new Refused(key); }

  @SuppressWarnings("unchecked")
  private static Map<String, ?> map(Object value, String key) {
    if (value instanceof Map<?, ?> m) return (Map<String, ?>) m;
    throw new Refused(key);
  }

  private static List<?> list(Map<String, ?> source, String key, boolean required) {
    Object value = source.get(key);
    if (value == null && !required) return List.of();
    if (value instanceof List<?> l && (!required || !l.isEmpty())) return l;
    throw new Refused(key);
  }
}
