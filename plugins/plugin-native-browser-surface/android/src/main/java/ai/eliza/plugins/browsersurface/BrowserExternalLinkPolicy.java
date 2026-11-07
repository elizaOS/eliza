package ai.eliza.plugins.browsersurface;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Generic policy for website links that belong to another app ({@code mailto:}, {@code tel:},
 * {@code market:} and {@code intent:}).
 *
 * <p>The host parses an {@code intent:} URI with the platform parser and passes its action, data
 * scheme and package here. When the decision is not {@link Handoff#REFUSE}, the host builds a
 * <em>fresh</em> implicit Intent of that kind: it never forwards the page's component, selector,
 * clip data, flags or extras, adds the browsable category for {@link Handoff#VIEW}, and refuses a
 * resolved target in its own package. {@link Handoff#DIAL} only opens the dialer; it never places a
 * call. Pure JVM; no Android types.
 */
public final class BrowserExternalLinkPolicy {
  public static final int MAX_LINK = 4096;
  public static final String ACTION_VIEW = "android.intent.action.VIEW";
  public static final Set<String> SCHEMES = Collections.unmodifiableSet(
      new HashSet<>(Arrays.asList("mailto", "tel", "intent", "market")));
  /** Schemes an {@code intent:} link may never carry as data. */
  public static final Set<String> FORBIDDEN_DATA =
      Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
          "file", "content", "javascript", "data", "blob", "about", "intent", "android-app")));

  public enum Handoff {
    /** {@code ACTION_SENDTO} with the {@code mailto:} address. */
    SEND_TO,
    /** {@code ACTION_DIAL}: the dialer opens with the number; no call is placed. */
    DIAL,
    /** {@code ACTION_VIEW} + {@code CATEGORY_BROWSABLE}. */
    VIEW,
    REFUSE
  }

  private BrowserExternalLinkPolicy() {}

  private static String scheme(String raw) {
    if (raw == null)
      return "";
    int colon = raw.indexOf(':');
    if (colon <= 0)
      return "";
    String scheme = raw.substring(0, colon);
    if (!scheme.matches("[A-Za-z][A-Za-z0-9+.-]*"))
      return "";
    return scheme.toLowerCase(Locale.ROOT);
  }

  /** Whether the browser hands this link to another app instead of loading it. */
  public static boolean external(String raw) {
    return SCHEMES.contains(scheme(raw));
  }

  private static boolean clean(String raw) {
    if (raw == null || raw.isEmpty() || raw.length() > MAX_LINK)
      return false;
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c < 0x20 || c == 0x7f)
        return false;
    }
    return true;
  }

  /**
   * The handoff for {@code raw}.
   *
   * @param userGesture true only for a navigation the user started by tapping; script navigations
   *     to another app are refused
   * @param intentAction for {@code intent:} links, the parsed action (null when absent)
   * @param intentDataScheme for {@code intent:} links, the parsed data scheme (null when absent)
   * @param intentPackage for {@code intent:} links, the parsed package (null when absent)
   * @param ownPackage the host's own package; links addressed to it are refused
   * @param hostSchemes the host's own custom URL schemes (lower case); never a handoff target
   */
  public static Handoff decide(String raw, boolean userGesture, String intentAction,
      String intentDataScheme, String intentPackage, String ownPackage, Set<String> hostSchemes) {
    if (!userGesture || !clean(raw))
      return Handoff.REFUSE;
    switch (scheme(raw)) {
      case "mailto":
        return Handoff.SEND_TO;
      case "tel":
        return Handoff.DIAL;
      case "market":
        return Handoff.VIEW;
      case "intent":
        if (intentAction != null && !ACTION_VIEW.equals(intentAction))
          return Handoff.REFUSE;
        if (intentDataScheme != null) {
          String target = intentDataScheme.toLowerCase(Locale.ROOT);
          if (target.isEmpty() || FORBIDDEN_DATA.contains(target))
            return Handoff.REFUSE;
          if (hostSchemes != null && hostSchemes.contains(target))
            return Handoff.REFUSE;
        }
        if (ownPackage != null && ownPackage.equals(intentPackage))
          return Handoff.REFUSE;
        return Handoff.VIEW;
      default:
        return Handoff.REFUSE;
    }
  }

  /**
   * The {@code browser_fallback_url} extra of an {@code intent:} link that the browser itself may
   * load when no app handles the link: https only, with a host, no user info and no control
   * characters or whitespace. Otherwise null.
   */
  public static String fallback(String value) {
    if (!clean(value) || !value.regionMatches(true, 0, "https://", 0, 8))
      return null;
    for (int i = 0; i < value.length(); i++)
      if (value.charAt(i) == ' ')
        return null;
    return BrowserWebOrigin.of(value) == null ? null : value;
  }
}
