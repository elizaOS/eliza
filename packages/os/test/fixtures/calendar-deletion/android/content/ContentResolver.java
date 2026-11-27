// spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
package android.content;

public abstract class ContentResolver {
  public abstract android.database.Cursor query(android.net.Uri uri, String[] projection, String selection, String[] arguments, String sort);
  public abstract ContentProviderResult[] applyBatch(String authority, java.util.ArrayList<ContentProviderOperation> operations) throws OperationApplicationException;
  public android.net.Uri insert(android.net.Uri uri, ContentValues values) { throw new AssertionError("A direct provider insert was attempted"); }
}
