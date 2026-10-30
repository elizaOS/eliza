package ai.eliza.plugins.agent.connection;

import org.json.JSONArray;
import org.json.JSONObject;

/** Exact common AppProvider reads; mutation routes retain their separate domain/owner contracts. */
public final class NativeAppReadPolicy {
  private NativeAppReadPolicy() {}
  private static final OwnerRoutePolicy POLICY = policy();

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
