// spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"; spec/os/agentService/config.md, "The host file names a qualified service class, and status and failure notification words of 1 to 200 characters on two differently named channels"; spec/agent/host/launch.md, "The launch document is accepted whole or refused whole"; spec/agent/access/routes.md, "A list is loaded whole or not at all"; spec/os/agentService/config.md, "Only a cloud launch is framed with the device key, and an own-key launch with the owner's provider key or none"
package ai.eliza.os.agent;

import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

public final class AgentConfig {
  public static final String DIRECTORY = "agent";
  public static final String HOST_ASSET = DIRECTORY + "/host.json", CHARACTER_ASSET = DIRECTORY + "/character.json", POLICY_ASSET = DIRECTORY + "/policy.json";
  public static final int MAX_FILE_BYTES = 256 * 1024;
  public static final int NOTIFICATION_TEXT_LIMIT = 200;

  private static final Pattern CLASS_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)+");
  private static final Pattern ORIGIN = Pattern.compile("https://([a-zA-Z0-9-]+\\.)*[a-zA-Z0-9-]+(:([0-9]{1,5}))?");
  private static final Pattern HTTPS_URL = Pattern.compile("https://[^\\s\\ufeff?#@]+", Pattern.UNICODE_CHARACTER_CLASS);
  private static final Pattern ENVIRONMENT_NAME = Pattern.compile("[A-Z][A-Z0-9_]*");
  private static final Pattern RESERVED_ENVIRONMENT = Pattern.compile("(ELIZA_AGENT_|ELIZA_CLOUD_|ELIZA_OWN_|LD_|NODE_).*|PATH|HOME|TMPDIR");
  private static final Pattern SHA256 = Pattern.compile("[a-f0-9]{64}");
  private static final Pattern VIEW_ID = Pattern.compile("[a-z][a-z0-9_-]{0,63}");
  private static final Pattern VIEW_PATH = Pattern.compile("/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+");
  private static final Pattern VIEW_ALIAS = Pattern.compile("[a-z](?:[a-z0-9 _-]{0,30}[a-z0-9])?");
  private static final int MAX_VIEWS = 32, MAX_VIEW_BYTES = 16384;
  private static final int OWN_KEY_MAX_UNITS = 1024;
  private static final BigDecimal SAFE_INTEGER = BigDecimal.valueOf(9007199254740991L);
  private static final Set<String> HOST_KEYS = Set.of("schema", "service", "notification", "routes", "nativeRoutes", "cloud", "model", "embeddings",
    "embeddingDimensions", "persistMemory", "callerRole", "views", "timeZone", "hostContextRevision", "privacy", "google", "retention", "environment");
  private static final Set<String> CHARACTER_KEYS = Set.of("name", "system", "bio", "adjectives", "style", "messageExamples");

  public static final class Refused extends Exception {
    Refused(String message) { super(message); }
  }

  public record Words(String channel, String title, String text) {}

  public record Notification(Words status, Words failure) {}

  /** What the owner allowed the agent to change in Google, as the service subclass keeps it for the next launch. */
  public record GoogleConsent(boolean gmailChanges, boolean calendarEdits) {}

  public record WorkflowWorker(String runtimeDir, String executable, String sha256) {
    public WorkflowWorker {
      if (!nonblank(runtimeDir) || !nonblank(executable) || sha256 == null || !SHA256.matcher(sha256).matches())
        throw new IllegalArgumentException("A workflow worker needs a directory, an executable and its sha256");
    }
  }

  public final String service;
  public final Notification notification;
  private final List<RouteGate.Group> rendererRoutes, nativeRoutes;
  private final Map<String, Object> character, policy, launch;
  private final boolean cloud;
  private final boolean ownKey;

  private AgentConfig(Map<String, Object> host, Map<String, Object> character, Map<String, Object> policy) throws Refused {
    known(host, HOST_KEYS, "host");
    schemaOne(host, "host");
    schemaOne(policy, "policy");
    if (!(host.get("service") instanceof String named) || !CLASS_NAME.matcher(named).matches()) throw new Refused("The agent service is not a class name");
    service = named;
    Map<String, Object> words = exact(host.get("notification"), Set.of("channel", "title", "text", "failure"), "notification");
    Words status = words(words, "notification");
    Words failure = words(exact(words.get("failure"), Set.of("channel", "title", "text"), "notification failure"), "notification failure");
    if (failure.channel().equals(status.channel())) throw new Refused("The agent notification failure channel needs a name other than the status channel's");
    notification = new Notification(status, failure);
    rendererRoutes = routes(host.get("routes"), "routes");
    nativeRoutes = host.containsKey("nativeRoutes") ? routes(host.get("nativeRoutes"), "nativeRoutes") : List.of();
    this.character = character(character);
    this.policy = policy(policy);
    launch = launch(host);
    Object backend = ((Map<?, ?>) launch.get("model")).get("backend");
    cloud = "cloud".equals(backend);
    ownKey = "own-key".equals(backend);
  }

  public static AgentConfig parse(byte[] host, byte[] character, byte[] policy) throws Refused {
    return new AgentConfig(file(host, "host"), file(character, "character"), file(policy, "policy"));
  }

  public List<RouteGate.Group> routes(ChannelPolicy.CallerKind kind) {
    return switch (kind) {
      case RENDERER -> rendererRoutes;
      case NATIVE -> nativeRoutes;
    };
  }

  public boolean needsAccount() { return cloud; }

  public boolean ownKey() { return ownKey; }

  LaunchFrame initialFrame(String token, long epoch, LaunchFrame.Credential credential, String storageKey) throws Refused {
    if (ownKey && credential != null && credential.value().length() > OWN_KEY_MAX_UNITS)
      throw new Refused("The provider key exceeds the agent's own-key slot");
    return LaunchFrame.first(token, epoch, credential, storageKey);
  }

  public String launchDocument(AgentCredentials.Account account, WorkflowWorker workflowWorker) { return launchDocument(account, workflowWorker, null); }

  /** The launch document; a consent the owner saved replaces the host file's {@code google} for this launch, and none keeps the host file's. */
  public String launchDocument(AgentCredentials.Account account, WorkflowWorker workflowWorker, GoogleConsent consent) {
    if (cloud && account == null) throw new IllegalArgumentException("A cloud launch names the signed-in account");
    Map<String, Object> document = new LinkedHashMap<>();
    document.put("schema", BigDecimal.ONE);
    document.put("character", character);
    document.put("policy", policy);
    document.put("model", launch.get("model"));
    if (account != null) document.put("account", ordered("userId", account.userId(), "organizationId", account.organizationId()));
    for (Map.Entry<String, Object> entry : launch.entrySet()) if (!entry.getKey().equals("model")) document.put(entry.getKey(), entry.getValue());
    if (consent != null) document.put("google", ordered("gmailChanges", consent.gmailChanges(), "calendarEdits", consent.calendarEdits()));
    if (workflowWorker != null)
      document.put("workflowWorker", ordered("runtimeDir", workflowWorker.runtimeDir(), "executable", workflowWorker.executable(), "sha256", workflowWorker.sha256()));
    return json(document);
  }

  @Override public String toString() { return "AgentConfig(" + service + ")"; }

  private static Map<String, Object> file(byte[] bytes, String name) throws Refused {
    if (bytes == null) throw new Refused("The agent " + name + " file is missing");
    if (bytes.length > MAX_FILE_BYTES) throw new Refused("The agent " + name + " file is larger than 256 KiB");
    try {
      String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
      if (RouteGate.Json.parse(text) instanceof Map<?, ?> map) return cast(map);
      throw new Refused("The agent " + name + " file is not a JSON object");
    } catch (CharacterCodingException | IllegalArgumentException invalid) {
      throw new Refused("The agent " + name + " file is not JSON");
    }
  }

  private static void schemaOne(Map<String, Object> file, String name) throws Refused {
    if (!(file.get("schema") instanceof BigDecimal schema) || schema.compareTo(BigDecimal.ONE) != 0) throw new Refused("The agent " + name + " file is not schema 1");
  }

  private static Words words(Map<String, Object> words, String name) throws Refused {
    return new Words(words(words, "channel", name), words(words, "title", name), words(words, "text", name));
  }

  private static String words(Map<String, Object> words, String key, String name) throws Refused {
    if (!(words.get(key) instanceof String value)) throw new Refused("The agent " + name + " needs a " + key);
    String trimmed = value.trim();
    if (trimmed.isEmpty() || trimmed.length() > NOTIFICATION_TEXT_LIMIT) throw new Refused("The agent " + name + " " + key + " is not 1 to 200 characters");
    return trimmed;
  }

  private static List<RouteGate.Group> routes(Object value, String name) throws Refused {
    RouteGate gate = new RouteGate();
    if (!(value instanceof List<?>) || !gate.loadWire(json(value))) throw new Refused("The agent " + name + " are not a route list");
    return gate.served();
  }

  private static Map<String, Object> character(Map<String, Object> character) throws Refused {
    known(character, CHARACTER_KEYS, "character");
    if (!(character.get("name") instanceof String name) || name.isEmpty() || name.length() > 50 || !trimmedLikeJs(name))
      throw new Refused("The agent character needs a trimmed name of 1 to 50 characters");
    if (!nonblank(character.get("system"))) throw new Refused("The agent character needs a system prompt");
    if (character.containsKey("bio") && !(character.get("bio") instanceof String) && !strings(character.get("bio"))) throw new Refused("The agent character bio is text");
    if (character.containsKey("adjectives") && !strings(character.get("adjectives"))) throw new Refused("The agent character adjectives are text");
    if (character.containsKey("style")) {
      Map<String, Object> style = exactOptional(character.get("style"), Set.of("all", "chat", "post"), "character style");
      for (Object lines : style.values()) if (!strings(lines)) throw new Refused("The agent character style is text");
    }
    if (character.containsKey("messageExamples")) {
      if (!(character.get("messageExamples") instanceof List<?> examples)) throw new Refused("The agent character examples are a list");
      for (Object example : examples)
        examples(example instanceof Map<?, ?> wrapped ? exact(wrapped, Set.of("examples"), "character example").get("examples") : example);
    }
    return character;
  }

  private static void examples(Object value) throws Refused {
    if (!(value instanceof List<?> turns)) throw new Refused("The agent character example is a list of turns");
    for (Object turn : turns) {
      Map<String, Object> said = exact(turn, Set.of("name", "content"), "character example turn");
      if (!nonblank(said.get("name"))) throw new Refused("The agent character example names its speaker");
      Map<String, Object> content = exactOptional(said.get("content"), Set.of("text", "actions"), "character example content");
      if (content.containsKey("text") && !(content.get("text") instanceof String)) throw new Refused("The agent character example text is text");
      if (content.containsKey("actions") && !names(content.get("actions"), false)) throw new Refused("The agent character example names its actions");
    }
  }

  private static Map<String, Object> policy(Map<String, Object> policy) throws Refused {
    if (!(policy.get("actions") instanceof Map<?, ?> actionsRaw)) throw new Refused("The agent policy needs actions");
    Map<String, Object> actions = cast(actionsRaw);
    Object allowedRaw = actions.get("allowed");
    List<Object> allowed = allowedRaw instanceof Map<?, ?> named ? new ArrayList<>(new TreeSet<>(cast(named).keySet())) : list(allowedRaw);
    if (allowed == null || allowed.isEmpty() || !names(allowed, true)) throw new Refused("The agent policy allows a nonempty set of named actions");
    Object refused = actions.get("refused");
    if (refused != null) {
      if (!(refused instanceof Map<?, ?> refusedNames)) throw new Refused("The agent policy refuses actions by name");
      for (Object action : allowed) if (refusedNames.containsKey(action)) throw new Refused("Action " + action + " is both allowed and refused");
    }
    if (!(policy.get("plugins") instanceof Map<?, ?> pluginsRaw)) throw new Refused("The agent policy needs a plugin load list");
    Map<String, Object> plugins = cast(pluginsRaw);
    if (!names(plugins.get("load"), true)) throw new Refused("The agent policy loads unique plugins by name");
    Map<String, Object> load = ordered("load", plugins.get("load"));
    if (plugins.containsKey("product")) {
      Object product = plugins.get("product");
      if (!nonblank(product) || ((List<?>) plugins.get("load")).contains(product)) throw new Refused("The agent product plugin is named once, outside the load list");
      load.put("product", product);
    }
    return ordered("actions", ordered("allowed", allowed), "plugins", load);
  }

  private static Map<String, Object> launch(Map<String, Object> host) throws Refused {
    Map<String, Object> launch = new LinkedHashMap<>();
    if (host.containsKey("cloud") == host.containsKey("model")) throw new Refused("The agent host names its model once, as model or as the schema 1 cloud record");
    launch.put("model", host.containsKey("model") ? model(host.get("model")) : cloudRecord(host.get("cloud")));
    Object embeddings = host.getOrDefault("embeddings", "none");
    if (!"none".equals(embeddings) && !"local".equals(embeddings)) throw new Refused("The agent embeddings are local or none");
    launch.put("embeddings", embeddings);
    if (host.containsKey("embeddingDimensions")) launch.put("embeddingDimensions", positiveInteger(host.get("embeddingDimensions"), "embeddingDimensions"));
    else if ("local".equals(embeddings)) throw new Refused("Local embeddings need their dimensions");
    Object persist = host.getOrDefault("persistMemory", Boolean.FALSE);
    if (!(persist instanceof Boolean)) throw new Refused("The agent persistMemory is true or false");
    launch.put("persistMemory", persist);
    Object role = host.getOrDefault("callerRole", "owner");
    if (!"owner".equals(role) && !"user".equals(role)) throw new Refused("The agent callerRole is owner or user");
    launch.put("callerRole", role);
    if (host.containsKey("views")) launch.put("views", views(host.get("views")));
    if (host.containsKey("timeZone")) {
      if (!(host.get("timeZone") instanceof String zone) || !(zone.equals("UTC") || (zone.contains("/") && ZoneId.getAvailableZoneIds().contains(zone))))
        throw new Refused("The agent time zone is a named zone");
      launch.put("timeZone", zone);
    }
    if (host.containsKey("hostContextRevision")) launch.put("hostContextRevision", positiveInteger(host.get("hostContextRevision"), "hostContextRevision"));
    if (host.containsKey("privacy")) launch.put("privacy", switches(host.get("privacy"), "secretSwap", "piiSwap"));
    if (host.containsKey("google")) launch.put("google", switches(host.get("google"), "gmailChanges", "calendarEdits"));
    if (host.containsKey("retention")) launch.put("retention", retention(host.get("retention")));
    if (host.containsKey("environment")) launch.put("environment", environment(host.get("environment")));
    return launch;
  }

  private static Map<String, Object> model(Object value) throws Refused {
    if (!(value instanceof Map<?, ?> raw)) throw new Refused("The agent model is an object");
    Object backend = raw.get("backend");
    if ("cloud".equals(backend)) {
      Map<String, Object> model = exact(raw, Set.of("backend", "cloudBaseUrl", "smallModel", "largeModel", "imageModel"), "model");
      origin(model.get("cloudBaseUrl"));
      for (String key : List.of("smallModel", "largeModel", "imageModel")) if (!(model.get(key) instanceof String)) throw new Refused("The agent cloud " + key + " is text");
      return ordered("backend", "cloud", "cloudBaseUrl", model.get("cloudBaseUrl"), "smallModel", model.get("smallModel"), "largeModel", model.get("largeModel"), "imageModel", model.get("imageModel"));
    }
    if ("own-key".equals(backend)) {
      Map<String, Object> model = exact(raw, Set.of("backend", "ownKeyBaseUrl", "ownKeySmall", "ownKeyLarge"), "model");
      if (!(model.get("ownKeyBaseUrl") instanceof String url) || !HTTPS_URL.matcher(url).matches() || !parsesAsUrl(url))
        throw new Refused("The agent own-key address is an https URL");
      if (!nonblank(model.get("ownKeySmall")) || !nonblank(model.get("ownKeyLarge"))) throw new Refused("An own-key model names both models");
      return ordered("backend", "own-key", "ownKeyBaseUrl", url, "ownKeySmall", model.get("ownKeySmall"), "ownKeyLarge", model.get("ownKeyLarge"));
    }
    if ("none".equals(backend)) {
      exact(raw, Set.of("backend"), "model");
      return ordered("backend", "none");
    }
    throw new Refused("The agent model backend is cloud, own-key or none");
  }

  private static Map<String, Object> cloudRecord(Object value) throws Refused {
    Map<String, Object> cloud = exactOptional(value, Set.of("baseUrl", "smallModel", "largeModel"), "cloud");
    origin(cloud.get("baseUrl"));
    for (String key : List.of("smallModel", "largeModel")) if (cloud.containsKey(key) && !(cloud.get(key) instanceof String)) throw new Refused("The agent cloud " + key + " is text");
    return ordered("backend", "cloud", "cloudBaseUrl", cloud.get("baseUrl"), "smallModel", cloud.getOrDefault("smallModel", ""),
      "largeModel", cloud.getOrDefault("largeModel", ""), "imageModel", "");
  }

  private static void origin(Object value) throws Refused {
    if (!(value instanceof String url) || !ORIGIN.matcher(url).matches() || !parsesAsUrl(url)) throw new Refused("The cloud address is an https origin");
  }

  private static boolean parsesAsUrl(String url) {
    int start = "https://".length(), end = start;
    while (end < url.length() && url.charAt(end) != '/') end++;
    String authority = url.substring(start, end);
    int colon = authority.lastIndexOf(':');
    if (colon < 0) return !authority.isEmpty();
    String port = authority.substring(colon + 1);
    return colon > 0 && !port.isEmpty() && port.length() <= 5 && port.chars().allMatch(Character::isDigit) && Integer.parseInt(port) <= 65535;
  }

  private static List<Object> views(Object value) throws Refused {
    List<Object> views = list(value);
    if (views == null || views.size() > MAX_VIEWS) throw new Refused("The agent views are a list of at most 32");
    Set<String> names = new HashSet<>(), paths = new HashSet<>();
    List<Object> out = new ArrayList<>();
    for (Object item : views) {
      Map<String, Object> view = exactOptional(item, Set.of("id", "label", "path", "aliases"), "view");
      if (!(view.get("id") instanceof String id) || !VIEW_ID.matcher(id).matches()) throw new Refused("An agent view id is a lowercase name");
      if (!(view.get("label") instanceof String label) || label.isEmpty() || label.length() > 80 || !trimmedLikeJs(label) || label.chars().anyMatch(Character::isISOControl))
        throw new Refused("An agent view label is 1 to 80 trimmed characters");
      if (!(view.get("path") instanceof String path) || path.length() > 256 || !VIEW_PATH.matcher(path).matches()) throw new Refused("An agent view path is an absolute path");
      List<Object> named = new ArrayList<>(List.of(id, label));
      Map<String, Object> declared = ordered("id", id, "label", label, "path", path);
      if (view.containsKey("aliases")) {
        List<Object> aliases = list(view.get("aliases"));
        if (aliases == null || aliases.isEmpty() || aliases.size() > 4 || !aliases.stream().allMatch(alias -> alias instanceof String text && VIEW_ALIAS.matcher(text).matches()))
          throw new Refused("An agent view has 1 to 4 lowercase aliases");
        named.addAll(aliases);
        declared.put("aliases", aliases);
      }
      Set<String> own = new HashSet<>();
      for (Object name : named) own.add(((String) name).toLowerCase(Locale.ROOT));
      for (String name : own) if (!names.add(name)) throw new Refused("No name belongs to two agent views");
      if (!paths.add(path)) throw new Refused("No path belongs to two agent views");
      out.add(declared);
    }
    if (json(out).getBytes(StandardCharsets.UTF_8).length > MAX_VIEW_BYTES) throw new Refused("The agent views are at most 16384 bytes");
    return out;
  }

  private static Map<String, Object> switches(Object value, String first, String second) throws Refused {
    Map<String, Object> switches = exact(value, Set.of(first, second), first + " and " + second);
    if (!(switches.get(first) instanceof Boolean) || !(switches.get(second) instanceof Boolean)) throw new Refused("The agent " + first + " and " + second + " are true or false");
    return ordered(first, switches.get(first), second, switches.get(second));
  }

  private static Map<String, Object> retention(Object value) throws Refused {
    Map<String, Object> retention = exact(value, Set.of("days", "maxRowsPerRoom", "intervalMinutes"), "retention");
    if (!(retention.get("days") instanceof BigDecimal days) || days.signum() <= 0) throw new Refused("The agent retention days are positive");
    return ordered("days", days, "maxRowsPerRoom", positiveInteger(retention.get("maxRowsPerRoom"), "maxRowsPerRoom"),
      "intervalMinutes", positiveInteger(retention.get("intervalMinutes"), "intervalMinutes"));
  }

  private static Map<String, Object> environment(Object value) throws Refused {
    if (!(value instanceof Map<?, ?> raw)) throw new Refused("The agent environment is an object");
    Map<String, Object> environment = new LinkedHashMap<>();
    for (Map.Entry<String, Object> entry : cast(raw).entrySet()) {
      String key = entry.getKey();
      if (!ENVIRONMENT_NAME.matcher(key).matches() || RESERVED_ENVIRONMENT.matcher(key).matches() || !(entry.getValue() instanceof String setting)
          || setting.chars().anyMatch(c -> c == 0 || c == '\r' || c == '\n'))
        throw new Refused("The agent environment may not set " + key);
      environment.put(key, setting);
    }
    return environment;
  }

  private static BigDecimal positiveInteger(Object value, String name) throws Refused {
    if (!(value instanceof BigDecimal number) || number.signum() <= 0 || number.stripTrailingZeros().scale() > 0 || number.compareTo(SAFE_INTEGER) > 0)
      throw new Refused("The agent " + name + " is a positive whole number");
    return new BigDecimal(number.toBigIntegerExact());
  }

  private static boolean names(Object value, boolean unique) {
    List<Object> items = list(value);
    if (items == null) return false;
    for (Object item : items) if (!nonblank(item)) return false;
    return !unique || new HashSet<>(items).size() == items.size();
  }

  private static boolean strings(Object value) {
    List<Object> items = list(value);
    return items != null && items.stream().allMatch(String.class::isInstance);
  }

  static boolean nonblank(Object value) {
    if (!(value instanceof String text)) return false;
    for (int at = 0; at < text.length(); at++) if (!jsSpace(text.charAt(at))) return true;
    return false;
  }

  private static boolean trimmedLikeJs(String text) { return !jsSpace(text.charAt(0)) && !jsSpace(text.charAt(text.length() - 1)); }

  private static boolean jsSpace(char c) {
    return c == ' ' || (c >= 0x09 && c <= 0x0d) || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
  }

  private static void known(Map<String, Object> map, Set<String> allowed, String name) throws Refused {
    for (String key : map.keySet()) if (!allowed.contains(key)) throw new Refused("The agent " + name + " has an unknown field " + key);
  }

  private static Map<String, Object> exact(Object value, Set<String> keys, String name) throws Refused {
    Map<String, Object> map = exactOptional(value, keys, name);
    for (String key : keys) if (!map.containsKey(key)) throw new Refused("The agent " + name + " needs " + key);
    return map;
  }

  private static Map<String, Object> exactOptional(Object value, Set<String> keys, String name) throws Refused {
    if (!(value instanceof Map<?, ?> raw)) throw new Refused("The agent " + name + " is an object");
    Map<String, Object> map = cast(raw);
    known(map, keys, name);
    return map;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> cast(Map<?, ?> map) { return (Map<String, Object>) map; }

  @SuppressWarnings("unchecked")
  private static List<Object> list(Object value) { return value instanceof List<?> items ? (List<Object>) items : null; }

  private static Map<String, Object> ordered(Object... pairs) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int at = 0; at < pairs.length; at += 2) map.put((String) pairs[at], pairs[at + 1]);
    return map;
  }

  static String json(Object value) {
    StringBuilder out = new StringBuilder();
    write(out, value);
    return out.toString();
  }

  private static void write(StringBuilder out, Object value) {
    if (value instanceof String text) quote(out, text);
    else if (value instanceof Boolean || value instanceof BigDecimal || value instanceof Long || value instanceof Integer) out.append(value);
    else if (value instanceof Map<?, ?> map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!first) out.append(',');
        first = false;
        quote(out, (String) entry.getKey());
        out.append(':');
        write(out, entry.getValue());
      }
      out.append('}');
    } else if (value instanceof List<?> list) {
      out.append('[');
      for (int at = 0; at < list.size(); at++) {
        if (at > 0) out.append(',');
        write(out, list.get(at));
      }
      out.append(']');
    } else if (value == RouteGate.Json.NULL) out.append("null");
    else throw new IllegalArgumentException("not a JSON value");
  }

  private static void quote(StringBuilder out, String text) {
    out.append('"');
    for (int at = 0; at < text.length(); at++) {
      char c = text.charAt(at);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20 || Character.isSurrogate(c) || c == 0x2028 || c == 0x2029) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    out.append('"');
  }
}
