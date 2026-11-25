// spec/os/android/files/documentGrants.md, "A selection reports its size and time only as the provider answered each"; spec/os/android/files/documentGrants.md, "Only retained selections survive a restart, and restore resumes the newest one still granted"
package ai.eliza.plugins.media;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import com.getcapacitor.JSObject;
import java.util.HashMap;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public final class SelectedDocumentDetailsTest {
  private static final String AUTHORITY = "documents.selected.test";
  private static final Map<String, Map<String, Object>> COLUMNS = new HashMap<>();
  private static final Map<String, String> REFUSED = new HashMap<>();
  private static final Map<String, String> REVOKED = new HashMap<>();

  public static final class Documents extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "application/pdf"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String order) {
      String document = uri.getLastPathSegment();
      String column = projection[0];
      if (column.equals(REFUSED.get(document))) throw new IllegalArgumentException("Unsupported column " + column);
      if (column.equals(REVOKED.get(document))) throw new SecurityException("Grant revoked");
      Map<String, Object> row = COLUMNS.getOrDefault(document, Map.of());
      MatrixCursor cursor = new MatrixCursor(projection);
      if (row.containsKey(column) || !column.equals(OpenableColumns.DISPLAY_NAME)) cursor.addRow(new Object[] {row.get(column)});
      return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] arguments) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] arguments) { return 0; }
  }

  private Context context;
  private SelectedDocuments documents;

  @Before public void provider() {
    COLUMNS.clear();
    REFUSED.clear();
    REVOKED.clear();
    Robolectric.setupContentProvider(Documents.class, AUTHORITY);
    context = RuntimeEnvironment.getApplication();
    documents = new SelectedDocuments(context, "selected-details", "selected-preview", uri -> false);
  }

  private static Uri document(String id, Object size, Object modified) {
    Map<String, Object> row = new HashMap<>();
    row.put(OpenableColumns.DISPLAY_NAME, id + ".pdf");
    row.put(OpenableColumns.SIZE, size);
    row.put(DocumentsContract.Document.COLUMN_LAST_MODIFIED, modified);
    COLUMNS.put(id, row);
    return Uri.parse("content://" + AUTHORITY + "/document/" + id);
  }

  @Test public void aSelectionReportsTheProviderSizeAndDateWhenKnown() throws Exception {
    JSObject described = documents.describeSelected(documents.authorize(document("report", 2048L, 1_760_000_000_000L), 0));
    assertEquals("selected", described.getString("status"));
    assertEquals(2048L, described.getLong("size"));
    assertEquals(1_760_000_000_000L, described.getLong("modified"));
  }

  @Test public void anUnknownSizeOrDateIsLeftOutNeverReportedAsZero() throws Exception {
    JSObject unknown = documents.describeSelected(documents.authorize(document("unknown", null, 0L), 0));
    assertEquals("selected", unknown.getString("status"));
    assertFalse(unknown.has("size"));
    assertFalse(unknown.has("modified"));
    JSObject empty = documents.describeSelected(documents.authorize(document("empty", 0L, null), 0));
    assertEquals(0L, empty.getLong("size"));
    assertFalse(empty.has("modified"));
  }

  @Test public void aColumnTheProviderRefusesHidesOnlyThatValue() throws Exception {
    Uri uri = document("partial", 512L, 1_760_000_000_000L);
    REFUSED.put("partial", DocumentsContract.Document.COLUMN_LAST_MODIFIED);
    JSObject described = documents.describeSelected(documents.authorize(uri, 0));
    assertEquals("selected", described.getString("status"));
    assertEquals(512L, described.getLong("size"));
    assertFalse(described.has("modified"));
  }

  @Test public void aRevokedGrantDuringTheSizeReadEndsTheSelection() throws Exception {
    Uri uri = document("revoked", 512L, 1_760_000_000_000L);
    REVOKED.put("revoked", OpenableColumns.SIZE);
    String id = documents.authorize(uri, 0);
    assertEquals("unavailable", documents.describeSelected(id).getString("status"));
    REVOKED.clear();
    assertEquals(null, documents.resolve(id));
  }

  @Test public void aRestoredSelectionReportsTheSameDetails() throws Exception {
    Uri uri = document("restored", 4096L, 1_760_000_100_000L);
    context.getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    documents.authorize(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
    JSObject restored = new SelectedDocuments(context, "selected-details", "selected-preview", reference -> false).restore();
    assertEquals("selected", restored.getString("status"));
    assertEquals(4096L, restored.getLong("size"));
    assertEquals(1_760_000_100_000L, restored.getLong("modified"));
    assertTrue(restored.getString("selectionId").matches("[a-f0-9-]{36}"));
  }
}
