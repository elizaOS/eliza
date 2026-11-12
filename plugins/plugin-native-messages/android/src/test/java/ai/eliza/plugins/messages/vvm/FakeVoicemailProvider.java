package ai.eliza.plugins.messages.vvm;

import android.content.ContentProvider;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.VoicemailContract;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.robolectric.Robolectric;

/**
 * A voicemail provider in memory with the parts of the real one's contract the client relies on:
 * the {@code voicemail} and {@code status} tables, row URIs, the {@code source_package} URI
 * parameter, {@code column = ?} selections, {@code DIRTY_RETAIN}, and a row's audio as a file opened
 * for reading or writing. It does not model permissions or who the caller is.
 */
public final class FakeVoicemailProvider extends ContentProvider {
 static final Map<String, List<Map<String, Object>>> tables = new HashMap<>();
 static long nextId;
 static int writes;

 static void install() {
  tables.clear(); nextId = 0; writes = 0;
  ProviderInfo info = new ProviderInfo();
  info.authority = VoicemailContract.AUTHORITY;
  Robolectric.buildContentProvider(FakeVoicemailProvider.class).create(info);
 }
 static List<Map<String, Object>> table(String name) { return tables.computeIfAbsent(name, key -> new ArrayList<>()); }
 static Map<String, Object> voicemail(long id) { for (Map<String, Object> row : table("voicemail")) if (Long.valueOf(id).equals(row.get("_id"))) return row; return null; }
 static Map<String, Object> byUid(String source, long uid) {
  for (Map<String, Object> row : table("voicemail")) if (source.equals(row.get("source_package")) && String.valueOf(uid).equals(row.get("source_data"))) return row;
  return null;
 }
 static File audioFile(Context context, long id) { return new File(context.getCacheDir(), "voicemail-" + id); }
 static byte[] audio(Context context, long id) throws java.io.IOException {
  File file = audioFile(context, id);
  return file.isFile() ? java.nio.file.Files.readAllBytes(file.toPath()) : null;
 }

 private List<Map<String, Object>> matching(Uri uri, String selection, String[] args) {
  List<String> path = uri.getPathSegments();
  String source = uri.getQueryParameter(VoicemailContract.PARAM_KEY_SOURCE_PACKAGE);
  List<String[]> clauses = new ArrayList<>();
  int arg = 0;
  if (selection != null) for (String clause : selection.split(" AND ")) {
   String[] sides = clause.split("=");
   if (sides.length != 2) throw new IllegalArgumentException("Unsupported selection: " + selection);
   clauses.add(new String[] { sides[0].trim(), sides[1].trim().equals("?") ? args[arg++] : sides[1].trim() });
  }
  List<Map<String, Object>> out = new ArrayList<>();
  rows: for (Map<String, Object> row : table(path.get(0))) {
   if (path.size() > 1 && !String.valueOf(row.get("_id")).equals(path.get(1))) continue;
   if (source != null && !source.equals(row.get("source_package"))) continue;
   for (String[] clause : clauses) if (!clause[1].equals(String.valueOf(row.get(clause[0])))) continue rows;
   out.add(row);
  }
  return out;
 }

 @Override public boolean onCreate() { return true; }
 @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
  MatrixCursor cursor = new MatrixCursor(projection);
  for (Map<String, Object> row : matching(uri, selection, args)) {
   Object[] values = new Object[projection.length];
   for (int i = 0; i < projection.length; i++) values[i] = row.get(projection[i]);
   cursor.addRow(values);
  }
  return cursor;
 }
 @Override public String getType(Uri uri) { return null; }
 @Override public Uri insert(Uri uri, ContentValues values) {
  writes++;
  String table = uri.getPathSegments().get(0);
  Map<String, Object> row = new HashMap<>();
  if (table.equals("voicemail")) { row.put("is_read", 0); row.put("dirty", 0); row.put("deleted", 0); row.put("has_content", 0); }
  for (String key : values.keySet()) row.put(key, values.get(key));
  long id = ++nextId;
  row.put("_id", id);
  table(table).add(row);
  return ContentUris.withAppendedId(uri, id);
 }
 @Override public int delete(Uri uri, String selection, String[] args) {
  writes++;
  List<Map<String, Object>> found = matching(uri, selection, args);
  table(uri.getPathSegments().get(0)).removeAll(found);
  for (Map<String, Object> row : found) audioFile(getContext(), (Long) row.get("_id")).delete();
  return found.size();
 }
 @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
  writes++;
  List<Map<String, Object>> found = matching(uri, selection, args);
  for (Map<String, Object> row : found) for (String key : values.keySet()) {
   if (key.equals("dirty") && Integer.valueOf(VoicemailContract.Voicemails.DIRTY_RETAIN).equals(values.get(key))) continue;
   row.put(key, values.get(key));
  }
  return found.size();
 }
 @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
  long id = Long.parseLong(uri.getLastPathSegment());
  if (voicemail(id) == null) throw new FileNotFoundException();
  File file = audioFile(getContext(), id);
  if (mode.contains("w")) return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE);
  if (!file.isFile()) throw new FileNotFoundException();
  return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
 }
}
