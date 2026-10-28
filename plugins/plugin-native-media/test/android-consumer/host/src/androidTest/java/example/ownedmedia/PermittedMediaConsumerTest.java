package example.ownedmedia;

import static org.junit.Assert.*;

import ai.eliza.plugins.media.*;
import android.Manifest;
import android.content.*;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.io.*;
import java.util.*;
import org.junit.Test;

/**
 * Real MediaStore and SharedPreferences execution of the permitted-library catalog, selected
 * documents and source references against items this fixture app publishes. Run only on an
 * isolated test device; it creates and removes its own synthetic media.
 */
public final class PermittedMediaConsumerTest {
  private static byte[] jpeg() {
    Bitmap pixels = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888);
    pixels.eraseColor(0xff3366ff);
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    assertTrue(pixels.compress(Bitmap.CompressFormat.JPEG, 90, encoded));
    pixels.recycle();
    return encoded.toByteArray();
  }
  private static Uri publish(ContentResolver resolver, String name, byte[] bytes) throws Exception {
    ContentValues values = new ContentValues();
    values.put("_display_name", name);
    values.put("mime_type", "image/jpeg");
    values.put("relative_path", "Pictures/PermittedMediaTest/");
    values.put("is_pending", 1);
    Uri item = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
    assertNotNull(item);
    try (OutputStream out = resolver.openOutputStream(item, "w")) {
      out.write(bytes);
    }
    ContentValues done = new ContentValues();
    done.put("is_pending", 0);
    assertEquals(1, resolver.update(item, done, null, null));
    return item;
  }

  @Test
  public void catalogReadsAndFencesTheFixturesOwnLibraryItems() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String pkg = context.getPackageName();
    for (String permission : Build.VERSION.SDK_INT >= 33
            ? new String[] {Manifest.permission.READ_MEDIA_IMAGES,
                  Manifest.permission.READ_MEDIA_VIDEO}
            : new String[] {Manifest.permission.READ_EXTERNAL_STORAGE})
      InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(
          pkg, permission);
    ContentResolver resolver = context.getContentResolver();
    byte[] bytes = jpeg();
    String name = "permitted-" + UUID.randomUUID() + ".jpg";
    Uri item = publish(resolver, name, bytes);
    PermittedMediaCatalog catalog = new PermittedMediaCatalog(context, false, () -> {});
    try {
      JSObject access = catalog.access();
      assertEquals("full", access.getString("scope"));
      PermittedMediaCatalog.Fence fence = catalog.fence();
      assertFalse(fence.cursorIdentity().isEmpty());
      JSObject page = catalog.list("", name.substring(0, 20), "image", false, "all");
      org.json.JSONArray items = page.getJSONArray("items");
      String id = null, revision = null;
      for (int i = 0; i < items.length(); i++)
        if (name.equals(items.getJSONObject(i).getString("name"))) {
          id = items.getJSONObject(i).getString("id");
          revision = items.getJSONObject(i).getString("revision");
          assertTrue(items.getJSONObject(i).getBoolean("owned"));
        }
      assertNotNull("provider search finds the published item", id);
      MediaLibraryKey key = MediaLibraryKey.parse(id);
      assertFalse(key.video);
      assertEquals(ContentUris.parseId(item), key.id);
      JSObject read = catalog.read(id, revision, false);
      assertEquals((long) bytes.length, (long) read.getLong("size"));
      catalog.requireCurrent(fence);
      // An exact-byte copy holds the same revision for the whole read.
      String exact = id, expected = revision;
      SelectedPhotoCopy.Copy copy = SelectedPhotoCopy.read(new SelectedPhotoCopy.Source() {
        public SelectedPhotoCopy.Metadata inspect() throws Exception {
          JSObject row = catalog.read(exact, expected, false);
          return new SelectedPhotoCopy.Metadata(row.getString("name"),
              resolver.getType(catalog.uri(key)), row.getLong("size"), row.getString("revision"),
              row.getString("identity"));
        }
        public InputStream open() throws Exception {
          return resolver.openInputStream(catalog.uri(key));
        }
      }, () -> catalog.requireCurrent(catalog.fence()));
      assertArrayEquals(bytes, copy.bytes);
      // A changed row is refused by its old revision.
      try (OutputStream out = resolver.openOutputStream(item, "wt")) {
        out.write(jpeg());
        out.write(0);
      }
      try {
        catalog.read(id, revision, false);
        fail("A rewritten item must not match its old revision");
      } catch (IllegalStateException | SecurityException expectedChange) {
        // Refused.
      }
      // Selected documents: a recorded selection resolves by its opaque ID only.
      String prefs = "fixture-selected-" + UUID.randomUUID().toString().substring(0, 8);
      SourceReferenceStore references =
          new SourceReferenceStore(context, prefs + "-refs", prefs + "-times");
      SelectedDocuments documents =
          new SelectedDocuments(context, prefs, "fixture-document-", references::retains);
      String selection = documents.authorize(item, 0);
      assertEquals(item, documents.resolve(selection));
      assertTrue(documents.selections().containsKey(selection));
      // No persisted grant: nothing is retained as a source reference.
      assertNull(references.retain(item, System.currentTimeMillis()));
      documents.forget(selection);
      assertNull(documents.resolve(selection));
      SourceReferenceStore.Reconciled pass =
          references.reconcile(Collections.emptySet(), System.currentTimeMillis(), uri -> false);
      assertEquals(0, pass.remaining);
    } finally {
      catalog.close();
      resolver.delete(item, null, null);
    }
  }
}
