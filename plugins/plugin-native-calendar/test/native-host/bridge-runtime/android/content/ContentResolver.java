package android.content;
public abstract class ContentResolver {public abstract android.database.Cursor query(android.net.Uri uri,String[] projection,String selection,String[] arguments,String sort);public android.net.Uri insert(android.net.Uri uri,ContentValues values){throw new AssertionError("Unexpected insert");}}
