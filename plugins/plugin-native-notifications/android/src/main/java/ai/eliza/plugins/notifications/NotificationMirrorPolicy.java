package ai.eliza.plugins.notifications;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Framework-free decisions for the opt-in notification mirror. No notification content is kept
 * here.
 */
public final class NotificationMirrorPolicy {
  private NotificationMirrorPolicy() {}
  public static final int MAX_SELECTED_APPS = 20, MAX_ACTIVE = 100, MAX_HISTORY = 100,
                          LABEL_LIMIT = 120, TITLE_LIMIT = 200, TEXT_LIMIT = 2000;
  public static final long HISTORY_RETENTION_MS = 86_400_000L;
  public static final String INITIAL_POLICY =
      "{\"revision\":\"initial\",\"enabled\":false,\"history\":false,\"apps\":[]}";
  /** A refusal whose message is safe to show the owner. */
  public static final class Rejected extends IllegalArgumentException {
    public Rejected(String message) {
      super(message);
    }
  }
  /**
   * The listener may observe only while the owner enabled it, did not pause it and Android granted
   * access.
   */
  public static boolean active(boolean enabled, boolean paused, boolean granted) {
    return enabled && !paused && granted;
  }
  /**
   * History is kept only while the listener is active and the owner separately opted into history.
   */
  public static boolean keepsHistory(
      boolean granted, boolean enabled, boolean history, boolean paused) {
    return active(enabled, paused, granted) && history;
  }
  /**
   * Validates a requested app selection against the launcher choices currently visible to the
   * owner.
   * {@code previousSignatureValid} maps each previously selected package to whether its pinned
   * signing certificate still matches; a changed app must be removed and chosen again.
   */
  public static void checkSelection(
      List<String> requested, Set<String> visible, Map<String, Boolean> previousSignatureValid) {
    if (requested.size() > MAX_SELECTED_APPS)
      throw new Rejected("Choose at most " + MAX_SELECTED_APPS + " apps");
    Set<String> seen = new HashSet<>();
    for (String name : requested) {
      if (name == null || !visible.contains(name) || !seen.add(name))
        throw new Rejected("This app is unavailable");
      if (Boolean.FALSE.equals(previousSignatureValid.get(name)))
        throw new Rejected("Remove and select this changed app again");
    }
  }
  /**
   * Only another app's notification for the same user, from the package's own uid, with a
   * still-matching pinned signature.
   */
  public static boolean admits(boolean sameUser, boolean ownPackage, boolean uidMatches,
      boolean selectedWithValidSignature) {
    return sameUser && !ownPackage && uidMatches && selectedWithValidSignature;
  }
  /**
   * Content is hidden unless the owner allowed previews for the app and the notification is not
   * secret.
   */
  public static boolean hidden(boolean previewAllowed, boolean secret) {
    return !previewAllowed || secret;
  }
  /** Opening runs only the posting app's own content intent, never one created by another uid. */
  public static boolean canOpen(
      boolean secret, boolean hasContentIntent, int creatorUid, int notificationUid) {
    return !secret && hasContentIntent && creatorUid == notificationUid;
  }
  public static boolean retained(long recordedAt, long now) {
    return recordedAt <= now && recordedAt > now - HISTORY_RETENTION_MS;
  }
  public static String bounded(CharSequence value, int max) {
    String text = value == null ? "" : value.toString();
    return text.length() > max ? text.substring(0, max) : text;
  }
}
