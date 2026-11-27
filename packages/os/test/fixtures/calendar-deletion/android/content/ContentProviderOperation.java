// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public final class ContentProviderOperation {
  public enum Kind { ASSERT, INSERT, UPDATE, DELETE }
  public final Kind kind;
  public final android.net.Uri uri;
  public ContentValues values;
  public String selection;
  public String[] arguments;
  public Integer expectedCount;
  private ContentProviderOperation(Kind kind, android.net.Uri uri) { this.kind = kind; this.uri = uri; }
  public static Builder newAssertQuery(android.net.Uri uri) { return new Builder(Kind.ASSERT, uri); }
  public static Builder newInsert(android.net.Uri uri) { return new Builder(Kind.INSERT, uri); }
  public static Builder newUpdate(android.net.Uri uri) { return new Builder(Kind.UPDATE, uri); }
  public static Builder newDelete(android.net.Uri uri) { return new Builder(Kind.DELETE, uri); }
  public static final class Builder {
    private final ContentProviderOperation operation;
    private Builder(Kind kind, android.net.Uri uri) { operation = new ContentProviderOperation(kind, uri); }
    public Builder withValues(ContentValues values) { operation.values = new ContentValues(values); return this; }
    public Builder withSelection(String selection, String[] arguments) { operation.selection = selection; operation.arguments = arguments; return this; }
    public Builder withExpectedCount(int count) { operation.expectedCount = count; return this; }
    public ContentProviderOperation build() { return operation; }
  }
}
