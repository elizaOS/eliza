package ai.eliza.plugins.agent.embedded;

import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** What a consumer supplies as data for the embedded cloud agent: the service class, the words of
 * its notification, the routes its page may reach, extra agent settings, the character, and the
 * action and plugin policy. Text and embeddings always go to Eliza Cloud, and the agent registers no
 * local model handler. */
public final class EmbeddedAgentConfig {
  public static final String HOST_ASSET = "eliza-agent.json", CHARACTER_ASSET = "eliza-agent-character.json", POLICY_ASSET = "eliza-agent-policy.json";
  public static final int MAX_ASSET_BYTES = 256 * 1024;
  private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+");
  private static final Pattern ENVIRONMENT_NAME = Pattern.compile("[A-Z][A-Z0-9_]*");
  private static final Pattern ROUTE = Pattern.compile("(/([A-Za-z0-9._-]+|\\{[a-z][A-Za-z]*\\}))+");
  private static final Pattern CLOUD_ORIGIN = Pattern.compile("https://[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?");
  private static final Pattern PARAMETER = Pattern.compile("[A-Za-z0-9_-]{1,128}");
  private static final Set<String> LAUNCH_SETTINGS = Set.of("PATH", "HOME", "TMPDIR", "ELIZA_PROVIDER", "ELIZA_STATE_DIR",
    "ELIZA_CONFIG_PATH", "ELIZA_PLATFORM", "ELIZA_REQUIRE_LOCAL_AUTH", "ELIZA_ACTION_ALLOWLIST", "ELIZA_PAIRING_DISABLED",
    "ELIZA_DISABLE_LOCAL_CHARACTER", "ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "ELIZA_ANDROID_APP_DATA_DIR",
    "ELIZA_BROWSER_ANDROID_APPLICATION", "ELIZA_MOBILE_DNS_SERVERS", "ELIZA_DEPLOYMENT_RUNTIME", "ELIZA_RUNTIME_MODE",
    "ELIZA_DISABLE_LOCAL_EMBEDDINGS", "EMBEDDING_PROVIDER", "EMBEDDING_BASE_URL");

  public static final class Notification {
    public final String channel, title, text;
    private Notification(String channel, String title, String text) { this.channel = channel; this.title = title; this.text = text; }
  }
  public static final class Route {
    public final String method;
    public final boolean stream;
    private final Pattern path;
    private Route(String method, String template, boolean stream) {
      this.method = method; this.stream = stream;
      StringBuilder regex = new StringBuilder();
      for (String segment : template.substring(1).split("/"))
        regex.append('/').append(segment.startsWith("{") ? PARAMETER.pattern() : Pattern.quote(segment));
      path = Pattern.compile(regex.toString());
    }
  }

  public final String service;
  public final Notification notification;
  private final String cloud;
  private final String smallModel, largeModel;
  private final boolean persistMemory;
  private final List<Route> routes = new ArrayList<>();
  private final Map<String, String> environment = new TreeMap<>();
  private final JSONObject character;
  private final List<String> allowedActions = new ArrayList<>();
  private final List<String> plugins = new ArrayList<>();

  private EmbeddedAgentConfig(JSONObject host, JSONObject character, JSONObject policy) throws IOException, JSONException {
    if (!schemaOne(host.opt("schema")) || !schemaOne(policy.opt("schema"))) throw new IOException("Unknown embedded agent schema");
    Object named = host.opt("service");
    if (!(named instanceof String) || !CLASS_NAME.matcher((String) named).matches()) throw new IOException("Invalid embedded agent service class");
    service = (String) named;
    JSONObject words = host.getJSONObject("notification");
    notification = new Notification(text(words, "channel"), text(words, "title"), text(words, "text"));
    JSONObject cloud = host.getJSONObject("cloud");
    String baseUrl = cloud.getString("baseUrl");
    if (!CLOUD_ORIGIN.matcher(baseUrl).matches()) throw new IOException("The Eliza Cloud address must be an https origin");
    this.cloud = baseUrl.replaceAll("/+$", "");
    smallModel = string(cloud, "smallModel"); largeModel = string(cloud, "largeModel");
    persistMemory = flag(host, "persistMemory");
    JSONArray routes = host.getJSONArray("routes");
    for (int index = 0; index < routes.length(); index++) {
      JSONObject route = routes.getJSONObject(index);
      String method = route.getString("method"), path = route.getString("path");
      if (!Set.of("GET", "POST", "PUT", "PATCH", "DELETE").contains(method) || !ROUTE.matcher(path).matches() || path.matches(".*/\\.+(/.*)?"))
        throw new IOException("Invalid embedded agent route");
      this.routes.add(new Route(method, path, flag(route, "stream")));
    }
    if (this.routes.isEmpty()) throw new IOException("The embedded agent admits no route");
    JSONObject settings = host.has("environment") ? host.getJSONObject("environment") : new JSONObject();
    for (Iterator<String> keys = settings.keys(); keys.hasNext();) {
      String key = keys.next();
      Object value = settings.get(key);
      if (!(value instanceof String) || !ENVIRONMENT_NAME.matcher(key).matches() || LAUNCH_SETTINGS.contains(key) || key.startsWith("ELIZA_API_")
          || key.startsWith("ELIZAOS_CLOUD_") || key.startsWith("ELIZA_AGENT_") || key.startsWith("ELIZA_CLOUD_") || key.startsWith("ELIZA_OWN_") || key.startsWith("NODE_") || key.startsWith("LD_") || ((String) value).chars().anyMatch(c -> c == 0 || c == '\n' || c == '\r'))
        throw new IOException("The embedded agent environment may not set " + key);
      environment.put(key, (String) value);
    }
    String name = string(character, "name").trim();
    if (name.isEmpty() || name.length() > 50 || string(character, "system").trim().isEmpty()) throw new IOException("Invalid embedded agent character");
    this.character = new JSONObject(character.toString());
    JSONObject actions = policy.getJSONObject("actions");
    for (Iterator<String> keys = actions.getJSONObject("allowed").keys(); keys.hasNext();) allowedActions.add(keys.next());
    if (allowedActions.isEmpty()) throw new IOException("The embedded agent policy allows no action");
    Collections.sort(allowedActions);
    JSONObject refused = actions.optJSONObject("refused");
    if (refused == null && actions.has("refused")) throw new IOException("The embedded agent policy refuses actions by name");
    if (refused != null) for (String action : allowedActions) if (refused.has(action)) throw new IOException("Action " + action + " is both allowed and refused");
    JSONArray load = policy.getJSONObject("plugins").getJSONArray("load");
    for (int index = 0; index < load.length(); index++) {
      Object plugin = load.get(index);
      if (!(plugin instanceof String value) || value.isBlank() || plugins.contains(value)) throw new IOException("Invalid embedded plugin load list");
      plugins.add(value);
    }
  }

  private static boolean schemaOne(Object schema) { return schema instanceof Number && ((Number) schema).doubleValue() == 1; }
  private static String string(JSONObject object, String key) throws IOException {
    Object value = object.opt(key);
    if (value == null) return "";
    if (!(value instanceof String)) throw new IOException("Embedded agent " + key + " must be text");
    return (String) value;
  }

  private static boolean flag(JSONObject object, String key) throws IOException {
    Object value = object.opt(key);
    if (value == null) return false;
    if (!(value instanceof Boolean)) throw new IOException("Embedded agent " + key + " must be true or false");
    return (Boolean) value;
  }

  private static String text(JSONObject words, String key) throws IOException {
    String value = string(words, key).trim();
    if (value.isEmpty() || value.length() > 200) throw new IOException("Invalid embedded agent notification " + key);
    return value;
  }

  public static EmbeddedAgentConfig parse(String host, String character, String policy) throws IOException {
    try { return new EmbeddedAgentConfig(new JSONObject(host), new JSONObject(character), new JSONObject(policy)); }
    catch (JSONException | IllegalArgumentException invalid) { throw new IOException("Invalid embedded agent data: " + invalid.getMessage(), invalid); }
  }

  /** The route a page may call with this method and path, or null. A query or fragment is never admitted. */
  public Route admit(String method, String path) {
    if (method == null || path == null) return null;
    for (Route route : routes) if (route.method.equals(method) && route.path.matcher(path).matches()) return route;
    return null;
  }

  public JSONObject agentConfig(String userId, String organizationId) throws JSONException {
    return new JSONObject().put("schema", 1)
      .put("character", new JSONObject(character.toString()))
      .put("model", new JSONObject().put("backend", "cloud").put("cloudBaseUrl", cloud)
        .put("smallModel", smallModel).put("largeModel", largeModel).put("imageModel", ""))
      .put("policy", new JSONObject()
        .put("actions", new JSONObject().put("allowed", new JSONArray(allowedActions)))
        .put("plugins", new JSONObject().put("load", new JSONArray(plugins))))
      .put("account", new JSONObject().put("userId", userId).put("organizationId", organizationId))
      .put("embeddings", "none").put("persistMemory", persistMemory).put("callerRole", "owner")
      .put("environment", new JSONObject(environment));
  }
}
