package ai.eliza.plugins.agent.connection;

import org.json.JSONArray;
import org.json.JSONObject;

/** Exact common AppProvider reads; mutation routes retain their separate domain/owner contracts. */
public final class NativeAppReadPolicy {
  private NativeAppReadPolicy() {}
  private static final OwnerRoutePolicy POLICY = policy();

  /** Claim read-shaped requests before validation; aliases cannot use the legacy transport.
   * Other methods retain the host's existing mutation contracts, including PUT /api/config. */
  public static boolean claims(String path, String method) {
    if (path == null || method == null || !"GET".equalsIgnoreCase(method.trim())) return false;
    return POLICY.allowed("app-reads", candidatePath(path), "GET");
  }

  /** Only for claiming aliases before strict validation; never dispatch this normalized path. */
  static String candidatePath(String path) {
    if (path == null) return "";
    String route = path.trim().split("[?#]", 2)[0].replace('\\', '/');
    try { route = java.net.URLDecoder.decode(route.replace("+", "%2B"), "UTF-8"); }
    catch (Exception invalid) { /* Match any remaining literal common prefix below. */ }
    java.util.ArrayList<String> segments = new java.util.ArrayList<>();
    for (String segment : route.replace('\\', '/').split("/")) {
      if (segment.isEmpty() || ".".equals(segment)) continue;
      if ("..".equals(segment)) { if (!segments.isEmpty()) segments.remove(segments.size() - 1); }
      else segments.add(segment);
    }
    return "/" + String.join("/", segments);
  }

  private static OwnerRoutePolicy policy() {
    try {
      JSONArray paths = new JSONArray(new String[] {
          "/api/auth/status", "/api/auth/me", "/api/agents", "/api/status",
          "/api/first-run/status", "/api/first-run/options", "/api/config", "/api/stream/settings",
          "/api/wallet/config", "/api/wallet/addresses", "/api/wallet/balances", "/api/wallet/nfts",
          "/api/plugins", "/api/skills", "/api/character", "/api/workbench/overview"});
      JSONArray routes = new JSONArray()
          .put(new JSONObject().put("methods", new JSONArray().put("GET")).put("paths", paths))
          .put(new JSONObject().put("methods", new JSONArray().put("GET"))
              .put("paths", new JSONArray().put("/api/update/status")).put("query", new JSONArray().put("force")))
          .put(new JSONObject().put("methods", new JSONArray().put("GET"))
              .put("paths", new JSONArray().put("/api/agent/events"))
              .put("query", new JSONArray().put("after").put("limit").put("runId").put("fromSeq")));
      return new OwnerRoutePolicy(new JSONObject().put("unsafe", "[\\\\#\\s]")
          .put("groups", new JSONObject().put("app-reads", new JSONObject()
              .put("prefixes", paths).put("routes", routes))).toString());
    } catch (Exception invalid) { throw new ExceptionInInitializerError(invalid); }
  }

  public static boolean allowed(String path, String method, String body) {
    if (body != null || !"GET".equals(method)) return false;
    if (path != null && path.startsWith("/api/update/status")
        && !path.equals("/api/update/status") && !path.equals("/api/update/status?force=true")) return false;
    return POLICY.allowed("app-reads", path, method);
  }
}
