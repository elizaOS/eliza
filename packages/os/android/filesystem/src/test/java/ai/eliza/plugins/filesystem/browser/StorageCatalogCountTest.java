// spec/os/android/files/storage.md, "A category count totals the sizes its files record, and a file without one adds nothing"
package ai.eliza.plugins.filesystem.browser;

import static org.junit.Assert.assertEquals;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import java.io.File;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE)
public final class StorageCatalogCountTest {
  private static final List<Object> SIZES = new ArrayList<>();
  private static final List<String> SELECTIONS = new ArrayList<>();

  public static final class Media extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return null; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String order) {
      SELECTIONS.add(selection);
      MatrixCursor cursor = new MatrixCursor(projection);
      for (Object size : SIZES) cursor.addRow(new Object[] {size});
      return cursor;
    }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int delete(Uri uri, String selection, String[] arguments) { return 0; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] arguments) { return 0; }
  }

  @Rule public final TemporaryFolder volume = new TemporaryFolder();

  @Before public void provider() {
    SIZES.clear();
    SELECTIONS.clear();
    Robolectric.setupContentProvider(Media.class, MediaStore.AUTHORITY);
  }

  private StorageBrowser browser() {
    return new StorageBrowser(volume.getRoot(), ".Trash-test");
  }

  @Test public void aMediaCategoryTotalsTheSizesItsRowsRecord() throws Exception {
    SIZES.add(100L);
    SIZES.add(null);
    SIZES.add(-5L);
    SIZES.add(50L);
    for (String category : new String[] {"images", "videos", "audio", "documents"}) {
      JSObject counted = StorageCatalog.count(RuntimeEnvironment.getApplication().getContentResolver(), browser(), category);
      assertEquals(category, 4, counted.getInt("count"));
      assertEquals(category, 150L, counted.getLong("bytes"));
    }
    for (String selection : SELECTIONS) assertEquals(true, selection.endsWith(StorageCatalog.VISIBLE));
  }

  @Test public void anEmptyCategoryCountsNothing() throws Exception {
    JSObject counted = StorageCatalog.count(RuntimeEnvironment.getApplication().getContentResolver(), browser(), "images");
    assertEquals(0, counted.getInt("count"));
    assertEquals(0L, counted.getLong("bytes"));
  }

  @Test public void downloadsTotalTheVisibleFilesDirectlyInTheFolder() throws Exception {
    File downloads = volume.newFolder(StorageCatalog.DOWNLOAD_FOLDER);
    Files.write(new File(downloads, "receipt").toPath(), new byte[3]);
    Files.write(new File(downloads, "ticket").toPath(), new byte[5]);
    Files.write(new File(downloads, ".partial").toPath(), new byte[7]);
    Files.write(new File(downloads, "empty").toPath(), new byte[0]);
    File nested = new File(downloads, "folder");
    nested.mkdirs();
    Files.write(new File(nested, "inside").toPath(), new byte[11]);
    JSObject counted = StorageCatalog.count(RuntimeEnvironment.getApplication().getContentResolver(), browser(), "downloads");
    assertEquals(3, counted.getInt("count"));
    assertEquals(8L, counted.getLong("bytes"));
  }

  @Test public void aMissingDownloadsFolderIsAnEmptyCategory() throws Exception {
    JSObject counted = StorageCatalog.count(RuntimeEnvironment.getApplication().getContentResolver(), browser(), "downloads");
    assertEquals(0, counted.getInt("count"));
    assertEquals(0L, counted.getLong("bytes"));
  }
}
