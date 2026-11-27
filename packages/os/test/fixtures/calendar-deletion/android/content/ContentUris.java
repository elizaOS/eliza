// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public final class ContentUris {
  private ContentUris() {}
  public static android.net.Uri withAppendedId(android.net.Uri uri, long id) { return uri.buildUpon().appendPath(Long.toString(id)).build(); }
  public static android.net.Uri.Builder appendId(android.net.Uri.Builder builder, long id) { return builder.appendPath(Long.toString(id)); }
  public static long parseId(android.net.Uri uri) { java.util.List<String> segments = uri.getPathSegments(); return Long.parseLong(segments.get(segments.size() - 1)); }
}
