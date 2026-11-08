package ai.eliza.plugins.media;

/**
 * Who reviews a permitted-library change and what the app's own review says. Pure Java so JVM
 * tests can check it without the Android framework.
 */
public final class PermittedMediaChange {
  private PermittedMediaChange() {}
  /**
   * Whether the app shows its own review before Android's. Android's favorite and trash requests
   * name the action and the items, so the owner's own reversible change goes straight to them.
   * Permanent deletion keeps the app's warning. An agent's request keeps the app's review, the only
   * place the owner sees what the agent asked for.
   */
  public static boolean appReview(boolean permanent, boolean agent) {
    return permanent || agent;
  }
  public static String title(int count, boolean favorite, boolean desired, boolean permanent) {
    String items = count + (count == 1 ? " item" : " items");
    if (permanent)
      return "Delete " + items + " forever?";
    if (favorite)
      return (desired ? "Favorite " : "Unfavorite ") + items + "?";
    return desired ? "Move " + items + " to Recently deleted?" : "Restore " + items + "?";
  }
  /** {@code names} lists every item, one per line. */
  public static String message(String names, boolean permanent) {
    return names
        + (permanent ? "\nThese items will be permanently deleted and cannot be recovered. "
                       + "Android will ask for access. Items restored or changed elsewhere will "
                       + "be skipped."
                     : "\nAndroid will ask for access. Only these items, as they are now, will be "
                       + "changed. Items changed elsewhere will be skipped.");
  }
}
