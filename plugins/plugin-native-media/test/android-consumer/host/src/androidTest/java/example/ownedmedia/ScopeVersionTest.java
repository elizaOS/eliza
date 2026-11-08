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
 * The published scope version stays put across pause, resume and screen-off, while page cursors
 * from before them come back as a typed stale cursor. Run only on an isolated test device; it
 * creates and removes its own synthetic media.
 */
public final class ScopeVersionTest {
  private static Uri publish(ContentResolver resolver, String name) throws Exception {
    Bitmap pixels = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888);
    pixels.eraseColor(0xff33aa66);
    ContentValues values = new ContentValues();
    values.put("_display_name", name);
    values.put("mime_type", "image/jpeg");
    values.put("relative_path", "Pictures/ScopeVersionTest/");
    values.put("is_pending", 1);
    Uri item = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
    assertNotNull(item);
    try (OutputStream out = resolver.openOutputStream(item, "w")) {
      assertTrue(pixels.compress(Bitmap.CompressFormat.JPEG, 90, out));
    } finally {
      pixels.recycle();
    }
    ContentValues done = new ContentValues();
    done.put("is_pending", 0);
    assertEquals(1, resolver.update(item, done, null, null));
    return item;
  }

  @Test
  public void pauseAndResumeKeepTheScopeVersionAndStaleTheirCursors() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    for (String permission : Build.VERSION.SDK_INT >= 33
            ? new String[] {Manifest.permission.READ_MEDIA_IMAGES,
                  Manifest.permission.READ_MEDIA_VIDEO}
            : new String[] {Manifest.permission.READ_EXTERNAL_STORAGE})
      InstrumentationRegistry.getInstrumentation().getUiAutomation().grantRuntimePermission(
          context.getPackageName(), permission);
    ContentResolver resolver = context.getContentResolver();
    String prefix = "scope-" + UUID.randomUUID().toString().substring(0, 8);
    List<Uri> items = new ArrayList<>();
    items.add(publish(resolver, prefix + "-a.jpg"));
    items.add(publish(resolver, prefix + "-b.jpg"));
    PermittedMediaCatalog catalog = new PermittedMediaCatalog(context, false, () -> {});
    try {
      String version = catalog.scopeVersion();
      assertFalse(version.isEmpty());
      JSObject first = catalog.list("", prefix, "image", false, "all", 0, Long.MAX_VALUE, 1);
      String next = first.getString("next");
      assertFalse("two matches give a second page", next.isEmpty());

      // Pause, resume and screen-off bump the catalog epoch but not the published version.
      catalog.foreground(false);
      catalog.foreground(true);
      catalog.invalidate();
      assertEquals(version, catalog.scopeVersion());
      assertEquals(version, catalog.scopeVersion());

      // A cursor from before the resume is refused as stale, not as an access change.
      try {
        catalog.list(next, prefix, "image", false, "all", 0, Long.MAX_VALUE, 1);
        fail("A pre-resume cursor must be stale");
      } catch (PermittedMediaCatalog.StaleCursor expected) {
        // The client loads the first page again.
      }
      JSObject again = catalog.list("", prefix, "image", false, "all", 0, Long.MAX_VALUE, 1);
      assertEquals(1, again.getJSONArray("items").length());
      assertFalse(again.getString("next").isEmpty());

      // A new photo is a library change, not a scope change: the version holds.
      items.add(publish(resolver, prefix + "-c.jpg"));
      assertEquals(version, catalog.scopeVersion());
    } finally {
      catalog.close();
      for (Uri item : items) resolver.delete(item, null, null);
    }
  }
}
