package ai.eliza.plugins.agent.connection;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Admission of a Cloud delegation return link ({@code <scheme>://<host>?state=...&code=...} or
 * {@code ...&error=...}). The product injects its own link scheme and host. Anything else (a port,
 * user info, a fragment, a path, extra or repeated parameters, a malformed state or an oversized
 * code) is an unsolicited link that never enters the authentication flow. The Android plugin
 * parses the intent URI and passes its parts; this check is pure so it is tested on the host JVM.
 */
public final class DelegationCallback {
  /** PKCE-style state: 32 random bytes, base64url without padding. */
  public static final String STATE_PATTERN = "[A-Za-z0-9_-]{43}";
  public static final int CODE_LIMIT = 4096;

  public final String state, code, error;

  private DelegationCallback(String state, String code, String error) {
    this.state = state;
    this.code = code;
    this.error = error;
  }

  /**
   * The admitted callback, or null. query maps each parameter name to every decoded value given;
   * error callbacks are reported to the renderer as access_denied whatever the provider sent.
   */
  public static DelegationCallback admit(
      String expectedScheme,
      String expectedHost,
      String scheme,
      String host,
      int port,
      String userInfo,
      String fragment,
      String path,
      Map<String, List<String>> query) {
    if (!expectedScheme.equals(scheme) || !expectedHost.equals(host) || port != -1 || userInfo != null || fragment != null)
      return null;
    if (path != null && !path.isEmpty() && !"/".equals(path)) return null;
    if (query == null) return null;
    Set<String> names = query.keySet();
    if (!names.equals(new HashSet<>(Arrays.asList("state", "code"))) && !names.equals(new HashSet<>(Arrays.asList("state", "error"))))
      return null;
    for (String name : names) if (query.get(name) == null || query.get(name).size() != 1) return null;
    String state = query.get("state").get(0);
    if (state == null || !state.matches(STATE_PATTERN)) return null;
    if (names.contains("code")) {
      String code = query.get("code").get(0);
      if (code == null || code.isEmpty() || code.length() > CODE_LIMIT) return null;
      return new DelegationCallback(state, code, null);
    }
    return new DelegationCallback(state, null, "access_denied");
  }
}
