package ai.eliza.plugins.agent.connection;

import java.nio.charset.StandardCharsets;

/** Common AppProvider reads and the exact onboarding/settings writes used by both hosts.
 * Server schemas, account admission and domain approvals still decide the requested effect. */
public final class NativeAppRequestPolicy {
  private NativeAppRequestPolicy() {}
  public static final int MAX_BODY_BYTES = 10 * 1024 * 1024;
  private static final String ACTIVATION = "/api/first-run/activation/";
  private static boolean activation(String path) {
    return path != null && path.matches("/api/first-run/activation/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
  }
  private static boolean startupPath(String path) {
    return "/api/first-run".equals(path) || "/api/config".equals(path)
        || "/api/character".equals(path) || "/api/stream/settings".equals(path)
        || "/api/config/schema".equals(path) || "/api/character/schema".equals(path)
        || path.startsWith(ACTIVATION);
  }
  public static boolean claims(String path, String method) {
    return NativeAppReadPolicy.claims(path, method) || startupPath(NativeAppReadPolicy.candidatePath(path));
  }
  public static boolean allowed(String path, String method, String body) {
    if (NativeAppReadPolicy.allowed(path, method, body)) return true;
    if ("GET".equals(method)) return body == null && (activation(path)
        || "/api/config/schema".equals(path) || "/api/character/schema".equals(path));
    boolean write = "POST".equals(method) && ("/api/first-run".equals(path) || "/api/stream/settings".equals(path))
        || "PUT".equals(method) && ("/api/config".equals(path) || "/api/character".equals(path));
    return write && body != null && !body.trim().isEmpty()
        && body.getBytes(StandardCharsets.UTF_8).length <= MAX_BODY_BYTES;
  }
  public static boolean acceptsIdempotencyKey(String path, String method) {
    return "/api/first-run".equals(path) && "POST".equals(method);
  }
}
