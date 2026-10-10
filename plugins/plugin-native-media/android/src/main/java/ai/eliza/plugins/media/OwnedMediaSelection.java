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
  private OwnedMediaSelection() {}
}
