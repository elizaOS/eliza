// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public class ContentProviderResult {
  public final android.net.Uri uri;
  public final Integer count;
  public ContentProviderResult(android.net.Uri uri) { this.uri = uri; this.count = null; }
  public ContentProviderResult(int count) { this.uri = null; this.count = count; }
}
