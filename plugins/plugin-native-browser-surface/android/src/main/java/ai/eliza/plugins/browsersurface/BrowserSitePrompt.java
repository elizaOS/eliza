package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BiFunction;
import java.util.function.Predicate;

/**
 * The site permission prompt's decisions, shared by browser hosts. The host owns the dialog, the
 * single open-prompt slot and the OS runtime permission request; this class decides who may be
 * asked, what is asked, what a stored decision already answers and what the prompt says.
 *
 * <ul>
 *   <li>Only a secure top-level page may be asked, and only for its own origin: an embedded
 *       frame's request, or one that arrives after the page moved to another origin, is refused.
 *   <li>Only the selected, shown page of a foreground host may prompt or use a stored Allow.
 *   <li>A private tab never reads or stores a decision; it is always asked.
 *   <li>A kind the host app cannot hold at all is refused with a notice, never prompted.
 *   <li>Every Allow still needs the OS runtime permission for the host app.
 * </ul>
 *
 * <p>Pure JVM; no Android types.
 */
public final class BrowserSitePrompt {
  public static final String CAMERA = "camera";
  public static final String MICROPHONE = "microphone";
  public static final String LOCATION = "location";
  private static final String[] CAMERA_PERMISSIONS = {"android.permission.CAMERA"};
  private static final String[] MICROPHONE_PERMISSIONS = {"android.permission.RECORD_AUDIO"};
  private static final String[] LOCATION_PERMISSIONS = {
    "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"
  };

  private BrowserSitePrompt() {}

  /** The Android runtime permissions behind a kind; for location, either one is enough. */
  public static String[] androidPermissions(String kind) {
    if (CAMERA.equals(kind)) return CAMERA_PERMISSIONS.clone();
    if (MICROPHONE.equals(kind)) return MICROPHONE_PERMISSIONS.clone();
    if (LOCATION.equals(kind)) return LOCATION_PERMISSIONS.clone();
    return new String[0];
  }

  /**
   * The origin that may be asked, or null. {@code committedUrl} is the last committed top-level
   * page, {@code currentUrl} what the surface shows now; same-document changes keep the origin, so
   * origins are compared, not URLs. {@code localTestHosts} admits 127.0.0.1/localhost over HTTP
   * and must be true only in developer builds.
   */
  public static String origin(String committedUrl, String currentUrl, String requested,
      boolean localTestHosts) {
    String page = BrowserWebOrigin.of(committedUrl), asked = BrowserWebOrigin.of(requested);
    if (page == null || !page.equals(asked) || !page.equals(BrowserWebOrigin.of(currentUrl)))
      return null;
    if (page.startsWith("https://")) return page;
    if (localTestHosts
        && (page.equals("http://127.0.0.1") || page.startsWith("http://127.0.0.1:")
            || page.equals("http://localhost") || page.startsWith("http://localhost:")))
      return page;
    return null;
  }

  /** What a request needs before any prompt is shown. */
  public static final class Plan {
    /** Kinds the host app can never hold; the host says so and does not prompt. */
    public final List<String> unavailable;
    /** Kinds a stored Allow already answers (never for private tabs). */
    public final Set<String> allowed;
    /** Kinds the person must be asked about. Empty means no prompt. */
    public final Set<String> asked;

    Plan(List<String> unavailable, Set<String> allowed, Set<String> asked) {
      this.unavailable = Collections.unmodifiableList(unavailable);
      this.allowed = Collections.unmodifiableSet(allowed);
      this.asked = Collections.unmodifiableSet(asked);
    }

    /** The kinds granted when the person answers (or none was asked). */
    public Set<String> granted(boolean allow) {
      LinkedHashSet<String> all = new LinkedHashSet<>(allowed);
      if (allow) all.addAll(asked);
      return Collections.unmodifiableSet(all);
    }
  }

  /**
   * Plans a request. A refused request (not promptable) plans nothing: no prompt, no stored Allow.
   *
   * @param promptable the requesting tab is the selected, shown page of a foreground host
   * @param ephemeral the requesting tab is private
   * @param grantable whether the host app declares the OS permission behind a kind
   * @param stored the persistent profile's decision for (origin, kind), or null; never called for
   *     a private tab; a failure to read is treated as no decision
   */
  public static Plan plan(String origin, Collection<String> kinds, boolean promptable,
      boolean ephemeral, Predicate<String> grantable, BiFunction<String, String, Boolean> stored) {
    ArrayList<String> unavailable = new ArrayList<>();
    LinkedHashSet<String> allowed = new LinkedHashSet<>(), asked = new LinkedHashSet<>();
    if (!promptable || origin == null || kinds == null)
      return new Plan(unavailable, allowed, asked);
    for (String kind : kinds) {
      if (!BrowserSitePermissions.KINDS.contains(kind)) continue;
      if (!grantable.test(kind)) {
        if (!unavailable.contains(kind)) unavailable.add(kind);
        continue;
      }
      Boolean decision = null;
      if (!ephemeral)
        try {
          decision = stored.apply(origin, kind);
        } catch (RuntimeException damaged) {
          decision = null;
        }
      if (Boolean.TRUE.equals(decision)) allowed.add(kind);
      else if (decision == null) asked.add(kind);
    }
    return new Plan(unavailable, allowed, asked);
  }

  /** "camera", "camera and microphone", "camera, microphone and location". */
  public static String labels(Collection<String> kinds) {
    StringBuilder out = new StringBuilder();
    int i = 0, size = kinds.size();
    for (String kind : kinds) {
      if (i > 0) out.append(i == size - 1 ? " and " : ", ");
      out.append(kind);
      i++;
    }
    return out.toString();
  }

  public static String title(Collection<String> kinds) {
    return "Allow " + labels(kinds) + "?";
  }

  /** The prompt body: who asks, for what, and whether the answer is remembered. */
  public static String message(String host, Collection<String> kinds, boolean ephemeral) {
    return host + " wants to use your " + labels(kinds) + "."
        + (ephemeral
            ? "\n\nPrivate tab: this choice is not remembered."
            : "\n\nYou can change this later with Clear data for this site.");
  }

  /** Notice for a kind the host app cannot hold. */
  public static String unavailableNotice(String kind) {
    return "Websites cannot use your " + kind + " in this app.";
  }
}
