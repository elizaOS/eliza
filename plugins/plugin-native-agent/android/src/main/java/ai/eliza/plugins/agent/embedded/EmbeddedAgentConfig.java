package ai.eliza.plugins.agent.embedded;

import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** What a consumer supplies as data for the embedded cloud agent: the service class, the words of
 * its notification, the routes its page may reach, extra agent settings, the character, and the
 * action and plugin policy. Inference always goes to Eliza Cloud; nothing here selects a local model. */
public final class EmbeddedAgentConfig {
  public static final String HOST_ASSET = "eliza-agent.json", CHARACTER_ASSET = "eliza-agent-character.json", POLICY_ASSET = "eliza-agent-policy.json";
  public static final int MAX_ASSET_BYTES = 256 * 1024;
  private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+");
  private static final Pattern ENVIRONMENT_NAME = Pattern.compile("[A-Z][A-Z0-9_]*");
  private static final Pattern ROUTE = Pattern.compile("(/([A-Za-z0-9._-]+|\\{[a-z][A-Za-z]*\\}))+");
  private static final Pattern CLOUD_ORIGIN = Pattern.compile("https://[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*/?");
  private static final Pattern PARAMETER = Pattern.compile("[A-Za-z0-9_-]{1,128}");
  private static final Set<String> LAUNCH_SETTINGS = Set.of("PATH", "HOME", "TMPDIR", "ELIZA_PROVIDER", "ELIZA_STATE_DIR",
    "ELIZA_CONFIG_PATH", "ELIZA_PLATFORM", "ELIZA_REQUIRE_LOCAL_AUTH", "ELIZA_ACTION_ALLOWLIST", "ELIZA_PAIRING_DISABLED",
    "ELIZA_DISABLE_LOCAL_CHARACTER", "ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "ELIZA_ANDROID_APP_DATA_DIR",
    "ELIZA_BROWSER_ANDROID_APPLICATION", "ELIZA_MOBILE_DNS_SERVERS");

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
  private final JSONArray deniedPlugins = new JSONArray();

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
          || key.startsWith("ELIZAOS_CLOUD_") || key.startsWith("LD_") || ((String) value).chars().anyMatch(c -> c == 0 || c == '\n' || c == '\r'))
        throw new IOException("The embedded agent environment may not set " + key);
      environment.put(key, (String) value);
    }
    String name = string(character, "name").trim();
    if (name.isEmpty() || name.length() > 50 || string(character, "system").trim().isEmpty()) throw new IOException("Invalid embedded agent character");
    this.character = new JSONObject(character.toString()).put("default", true);
    JSONObject actions = policy.getJSONObject("actions");
    for (Iterator<String> keys = actions.getJSONObject("allowed").keys(); keys.hasNext();) allowedActions.add(keys.next());
    if (allowedActions.isEmpty()) throw new IOException("The embedded agent policy allows no action");
    Collections.sort(allowedActions);
    JSONObject refused = actions.optJSONObject("refused");
    if (refused != null) for (String action : allowedActions) if (refused.has(action)) throw new IOException("Action " + action + " is both allowed and refused");
    JSONObject plugins = policy.optJSONObject("plugins");
    JSONArray denied = plugins == null || !plugins.has("denied") ? new JSONArray() : plugins.getJSONArray("denied");
    for (int index = 0; index < denied.length(); index++) {
      if (!(denied.get(index) instanceof String)) throw new IOException("The embedded agent policy denies plugins by name");
      deniedPlugins.put(denied.get(index));
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

  /** The agent's launch configuration: cloud inference, the character, and the policy's plugin denials. */
  public JSONObject agentConfig() throws JSONException {
    JSONObject text = new JSONObject().put("backend", "elizacloud").put("transport", "cloud-proxy").put("accountId", "elizacloud");
    if (!smallModel.isEmpty()) text.put("smallModel", smallModel);
    if (!largeModel.isEmpty()) text.put("largeModel", largeModel);
    JSONObject config = new JSONObject().put("deploymentTarget", new JSONObject().put("runtime", "local"))
      .put("cloud", new JSONObject().put("enabled", true))
      .put("serviceRouting", new JSONObject().put("llmText", text))
      .put("plugins", new JSONObject().put("deny", new JSONArray(deniedPlugins.toString())))
      .put("hooks", new JSONObject().put("internal", new JSONObject().put("enabled", false)))
      .put("agents", new JSONObject().put("list", new JSONArray().put(new JSONObject(character.toString()))))
      .put("ui", new JSONObject().put("assistant", new JSONObject().put("name", character.getString("name").trim())));
    if (!persistMemory) config.put("database", new JSONObject().put("provider", "pglite").put("pglite", new JSONObject().put("dataDir", "memory://")));
    return config;
  }

  /** The agent's settings: the consumer's own, then the cloud credential and policy, which it cannot replace. */
  public Map<String, String> agentEnvironment(String credential) {
    if (credential == null || credential.isEmpty() || credential.chars().anyMatch(c -> c <= 32 || c >= 127))
      throw new IllegalArgumentException("A single-line cloud credential is required");
    Map<String, String> env = new HashMap<>(environment);
    env.put("ELIZA_PROVIDER", "elizacloud");
    env.put("ELIZAOS_CLOUD_USE_INFERENCE", "true");
    env.put("ELIZAOS_CLOUD_API_KEY", credential);
    env.put("ELIZAOS_CLOUD_BASE_URL", cloud);
    if (!smallModel.isEmpty()) env.put("ELIZAOS_CLOUD_SMALL_MODEL", smallModel);
    if (!largeModel.isEmpty()) env.put("ELIZAOS_CLOUD_LARGE_MODEL", largeModel);
    env.put("ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS", "ELIZAOS_CLOUD_API_KEY");
    env.put("ELIZA_ACTION_ALLOWLIST", new JSONArray(allowedActions).toString());
    env.put("ELIZA_DISABLE_LOCAL_CHARACTER", "1");
    env.put("ELIZA_PAIRING_DISABLED", "1");
    return env;
  }
}
