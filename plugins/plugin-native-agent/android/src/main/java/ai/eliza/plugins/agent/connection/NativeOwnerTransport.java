package ai.eliza.plugins.agent.connection;

import org.json.JSONObject;

/** Native-only owner enrollment and request projection over the host's existing lifecycle/cache. */
public final class NativeOwnerTransport {
  private NativeOwnerTransport() {}

  /** Never returned to a renderer. The host retains its existing in-memory cache. */
  public static final class Session {
    public final String root, token, identity;
    public final long expiresAt;
    public Session(String root, String token, String identity, long expiresAt) {
      this.root = root; this.token = token; this.identity = identity; this.expiresAt = expiresAt;
    }
  }

  public interface Host {
    Object enrollmentLock();
    String root() throws Exception;
    /** Require the original request lifecycle and the supplied current root. */
    void check(String root) throws Exception;
    Session cached(String root, long minimumExpiry) throws Exception;
    void publish(Session session) throws Exception;
    void invalidate(Session session) throws Exception;
    long now();
    JSONObject exchange(String path, String method, String body, String bearer, JSONObject headers) throws Exception;
  }

  private static JSONObject json(Host host, String root, String path, String method,
      JSONObject body, String bearer) throws Exception {
    host.check(root);
    JSONObject response = host.exchange(path, method, body == null ? null : body.toString(), bearer, null);
    host.check(root);
    if (response.getInt("status") != 200) throw new IllegalStateException("Local enrollment unavailable");
    return new JSONObject(response.getString("body"));
  }

  public static Session enroll(Host host) throws Exception {
    synchronized (host.enrollmentLock()) {
      String root = host.root();
      if (root == null || root.isEmpty()) throw new IllegalStateException("Local runtime unavailable");
      host.check(root);
      Session cached = host.cached(root, host.now() + 30_000);
      if (cached != null) return cached;
      JSONObject status = json(host, root, "/api/auth/status", "GET", null, root);
      if (!Boolean.TRUE.equals(status.opt("authenticated")) || status.getString("instanceId").isEmpty())
        throw new IllegalStateException("Local runtime not authenticated");
      JSONObject code = json(host, root, "/api/auth/pair-code", "GET", null, root);
      JSONObject paired = json(host, root, "/api/auth/pair", "POST",
          new JSONObject().put("code", code.getString("code")).put("instanceId", status.getString("instanceId")), root);
      if (!"owner".equals(paired.getString("access")) || !status.getString("instanceId").equals(paired.getString("instanceId")))
        throw new IllegalStateException("Local owner enrollment unconfirmed");
      String token = paired.getString("token"), identity = paired.getString("identityId");
      if (token.isEmpty() || identity.isEmpty()) throw new IllegalStateException("Local owner enrollment unconfirmed");
      JSONObject who = json(host, root, "/api/auth/me", "GET", null, token);
      if (!"OWNER".equals(who.getJSONObject("access").getString("role"))
          || !identity.equals(who.getJSONObject("identity").getString("id"))
          || !token.equals(who.getJSONObject("session").getString("id")))
        throw new IllegalStateException("Local owner readback unconfirmed");
      long expiry = who.getJSONObject("session").getLong("expiresAt");
      if (expiry <= host.now()) throw new IllegalStateException("Local owner expired");
      Session result = new Session(root, token, identity, expiry);
      host.check(root);
      host.publish(result);
      return result;
    }
  }

  /** Requirements are not owner proof, and this read does not enroll or publish a session. */
  public static JSONObject requirements(Host host) throws Exception {
    String root = host.root();
    if (root == null || root.isEmpty()) throw new IllegalStateException("Local runtime unavailable");
    host.check(root);
    JSONObject response = host.exchange("/api/auth/status", "GET", null, root, null);
    host.check(root);
    return response;
  }

  /** Route admission is decided before this call. Every request uses the verified native owner. */
  public static JSONObject request(Host host, String path, String method, String body,
      String expectedOwner, JSONObject headers) throws Exception {
    JSONObject safeHeaders = requestHeaders(headers, path, method);
    Session session = enroll(host);
    host.check(session.root);
    if (expectedOwner != null && !expectedOwner.equals(session.identity))
      return new JSONObject().put("status", 409).put("body", "{\"error\":\"Local owner changed; reconnect before continuing\"}");
    JSONObject result = host.exchange(path, method, body, session.token, safeHeaders);
    host.check(session.root);
    if (result.getInt("status") == 401) host.invalidate(session);
    if ("/api/auth/me".equals(path.split("\\?", 2)[0]) && result.getInt("status") == 200) {
      JSONObject who = new JSONObject(result.getString("body"));
      who.getJSONObject("session").put("id", "native-owned-session");
      result.put("body", who.toString());
      result.remove("bodyBase64");
    }
    return result;
  }

  /** A renderer never supplies the owner bearer or transport headers. */
  public static JSONObject requestHeaders(JSONObject supplied) throws Exception {
    return requestHeaders(supplied, null, null);
  }

  /** First-run uses the client's idempotency header. Keep its HTTP field value unchanged;
   * the server owns operation semantics. Match names without case, as Headers does. */
  public static JSONObject requestHeaders(JSONObject supplied, String path, String method) throws Exception {
    JSONObject result = new JSONObject();
    if (supplied != null) for (java.util.Iterator<String> keys = supplied.keys(); keys.hasNext();) {
      String key = keys.next(), name = null;
      for (String candidate : new String[] {
          "X-Eliza-Device-Id", "X-Eliza-Device-Key", "X-Eliza-Device-Capabilities", "X-ElizaOS-Client-Id"})
        if (candidate.equalsIgnoreCase(key)) name = candidate;
      if ("Idempotency-Key".equalsIgnoreCase(key)
          && NativeAppRequestPolicy.acceptsIdempotencyKey(path, method)) name = "Idempotency-Key";
      if (name == null) continue;
      if (result.has(name) || !(supplied.opt(key) instanceof String))
        throw new IllegalArgumentException("Invalid native request header");
      String value = supplied.getString(key);
      if (value.length() > 2048 || value.contains("\r") || value.contains("\n")
          || "X-ElizaOS-Client-Id".equals(name) && !value.matches("[A-Za-z0-9._-]{1,128}")
          || "Idempotency-Key".equals(name) && (value.trim().isEmpty()
              || value.length() > 512 || !value.matches("[\\x20-\\x7e]+")))
        throw new IllegalArgumentException("Invalid native request header");
      result.put(name, value);
    }
    return result;
  }
}
