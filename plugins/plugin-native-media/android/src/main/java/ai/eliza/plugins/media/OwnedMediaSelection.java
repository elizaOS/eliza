package ai.eliza.plugins.media;

/**
 * MediaStore selections limited to the host's own published items. The owner package is
 * always a bound argument, never concatenated. Pure Java so JVM tests cover it.
 */
public final class OwnedMediaSelection {
  /** Owned, fully written items; on API 30+ either trashed or not trashed, never both. */
  public static String owned(int sdk, boolean trashed) {
    if (trashed && sdk < 30)
      throw new IllegalArgumentException("Android trash requires Android 11 or later");
    return "owner_package_name=? AND is_pending=0"
        + (sdk >= 30 ? " AND is_trashed=" + (trashed ? 1 : 0) : "");
  }
  /** Owned images and videos in the Files catalog, newest first by id, before a cursor. */
  public static String page(int sdk, boolean trashed, String album) {
    String filter;
    switch (album == null ? "" : album) {
      case "":
        filter = "";
        break;
      case "videos":
        filter = " AND media_type=3";
        break;
      case "favorites":
        if (sdk < 30)
          throw new IllegalArgumentException("Favorites require Android 11 or later");
        filter = " AND is_favorite=1";
        break;
      default:
        throw new IllegalArgumentException("Unknown album");
    }
    if (trashed && !filter.isEmpty())
      throw new IllegalArgumentException("Trash has no albums");
    return owned(sdk, trashed) + " AND media_type IN (1,3)" + filter + " AND _id<?";
  }
  /** Revision of one row: date added, size and, on API 30+, generation and trash state. */
  public static String revision(
      int sdk, long dateAdded, long size, long generationModified, int trashed) {
    return dateAdded + ":" + size + (sdk >= 30 ? ":" + generationModified + ":" + trashed : "");
  }
  /** A positive cursor; blank means the newest page. */
  public static long cursor(String before) {
    if (before == null || before.isEmpty())
      return Long.MAX_VALUE;
    long value = Long.parseLong(before);
    if (value <= 0)
      throw new IllegalArgumentException("Invalid page cursor");
    return value;
  }
  /** True when {@code key} names an owned item: {@code <id>} (photo) or {@code v:<id>} (video). */
  public static boolean isOwnedKey(String key) {
    return key != null && key.matches("(?:v:)?[1-9][0-9]*");
  }
  /** The MediaStore id of an owned item name. */
  public static long id(String key) {
    if (!isOwnedKey(key))
      throw new IllegalArgumentException("Select owned media first");
    return Long.parseLong(key.replaceFirst("^v:", ""));
  }
  /**
   * MIME type for one share of several items: the common type, else {@code image/*} or {@code
   * video/*} when they share a family, else any type.
   */
  public static String shareType(String current, String next) {
    if (current == null || current.equals(next))
      return next;
    if (current.startsWith("image/") && next.startsWith("image/"))
      return "image/*";
    if (current.startsWith("video/") && next.startsWith("video/"))
      return "video/*";
    return "*/*";
  }
  /** A trimmed custom album name of 1–80 characters without control characters. */
  public static String albumName(String value) {
    String name = value == null ? "" : value.trim();
    if (name.isEmpty() || name.length() > 80 || name.chars().anyMatch(Character::isISOControl))
      throw new IllegalArgumentException("Use an album name of 1–80 characters");
    return name;
  }
  private OwnedMediaSelection() {}
}
