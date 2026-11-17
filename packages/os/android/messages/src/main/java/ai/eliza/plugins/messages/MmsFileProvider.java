package ai.eliza.plugins.messages;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.FileNotFoundException;

/**
 * Serves the PDU files the platform MMS service reads (sends) and writes (downloads). Declared by the
 * host, not exported, with grantUriPermissions: only the per-request grant SmsManager makes reaches a
 * file, and only names this module created (a random UUID) resolve.
 */
public final class MmsFileProvider extends ContentProvider {
 @Override public boolean onCreate() { return true; }
 @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
  String name = uri.getLastPathSegment();
  if (uri.getPathSegments().size() != 1 || !MmsStore.validFileName(name)) throw new FileNotFoundException("Unknown MMS file");
  int access;
  if ("r".equals(mode)) access = ParcelFileDescriptor.MODE_READ_ONLY;
  else if ("w".equals(mode) || "wt".equals(mode)) access = ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE;
  else throw new FileNotFoundException("Unsupported MMS file mode");
  return ParcelFileDescriptor.open(MmsStore.file(getContext(), name), access);
 }
 @Override public String getType(Uri uri) { return "application/vnd.wap.mms-message"; }
 @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
 @Override public Uri insert(Uri uri, ContentValues values) { return null; }
 @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
 @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
