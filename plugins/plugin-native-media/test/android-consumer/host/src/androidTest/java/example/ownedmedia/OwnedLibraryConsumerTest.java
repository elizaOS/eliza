package example.ownedmedia;

import static org.junit.Assert.*;

import ai.eliza.plugins.media.*;
import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;

/** Owned listing, fenced favorite/trash changes, two-step removal and custom albums on a device. */
public final class OwnedLibraryConsumerTest {
  private static JSONObject find(JSONArray items, String id) throws Exception {
    for (int i = 0; i < items.length(); i++)
      if (items.getJSONObject(i).getString("id").equals(id)) return items.getJSONObject(i);
    return null;
  }

  @Test
  public void ownedLibraryChangesOnlyListedRevisions() throws Exception {
    Assume.assumeTrue(Build.VERSION.SDK_INT >= 30);
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    ContentResolver resolver = context.getContentResolver();
    String namespace = "fixture" + UUID.randomUUID().toString().replace("-", "");
    OwnedMediaConfig config =
        OwnedMediaConfig.builder(namespace)
            .edits("Pictures/OwnedLibraryTest/Edits/", "edit-")
            .captures("Pictures/OwnedLibraryTest/", "capture-")
            .build();
    Bitmap pixels = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888);
    pixels.eraseColor(0xff2266ee);
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    assertTrue(pixels.compress(Bitmap.CompressFormat.JPEG, 95, encoded));
    pixels.recycle();
    String base64 = Base64.getEncoder().encodeToString(encoded.toByteArray());
    OwnedCaptures captures = new OwnedCaptures(context, config);
    List<Uri> revoked = new ArrayList<>();
    OwnedMediaLibrary library = new OwnedMediaLibrary(context, config, revoked::add);
    List<String> created = new ArrayList<>();
    try {
      for (int i = 0; i < 2; i++) {
        OwnedCaptures.Result saved = captures.keep(UUID.randomUUID().toString(), base64);
        assertTrue(saved.message, saved.saved);
        created.add(saved.id);
      }
      String first = created.get(0), second = created.get(1);
      JSONArray page = library.list("", false, "").getJSONArray("items");
      JSONObject listed = find(page, first);
      assertNotNull(listed);
      assertTrue(listed.getString("image").startsWith("data:image/jpeg;base64,"));
      String revision = listed.getString("mutationRevision");
      assertEquals(OwnedMediaLibrary.uri(first), library.verified(first, revision));

      // A stale revision never writes; the listed one does, and its revision then changes.
      try {
        library.changeFlag(first, revision + "0", true, true);
        fail("stale revision accepted");
      } catch (IllegalStateException stale) {
        assertEquals("stale", stale.getMessage());
      }
      JSObject favorite = library.changeFlag(first, revision, true, true);
      assertEquals("favorited", favorite.getString("status"));
      assertNotEquals(revision, favorite.getString("mutationRevision"));
      assertNotNull(find(library.list("", false, "favorites").getJSONArray("items"), first));
      assertEquals(
          "unchanged",
          library.changeFlag(first, favorite.getString("mutationRevision"), true, true)
              .getString("status"));

      // Custom album membership follows the owned identity and the album revision.
      PermittedMediaCatalog permitted = new PermittedMediaCatalog(context, () -> {});
      try {
        OwnedAlbums albums = new OwnedAlbums(context, config, library, permitted);
        JSObject album =
            albums.change(
                "create", null, null, " Trip ", first, favorite.getString("mutationRevision"), null);
        assertEquals("saved", album.getString("status"));
        JSObject listedAlbum = albums.list(album.getString("id"), "");
        assertEquals("Trip", listedAlbum.getString("name"));
        assertNotNull(find(listedAlbum.getJSONArray("items"), first));
        try {
          albums.change("rename", album.getString("id"), "old", "X", null, null, null);
          fail("stale album revision accepted");
        } catch (IllegalArgumentException changed) {
          assertTrue(changed.getMessage().startsWith("Album changed"));
        }
        assertEquals(
            "deleted",
            albums
                .change("delete", album.getString("id"), album.getString("revision"), null, null, null, null)
                .getString("status"));
      } finally {
        permitted.close();
      }

      // Trash, then a batch restore, then trash both and remove only the confirmed generations.
      JSObject trashed = library.changeFlag(second, find(page, second).getString("mutationRevision"), false, true);
      assertEquals("trashed", trashed.getString("status"));
      assertNotNull(find(library.list("", true, "").getJSONArray("items"), second));
      JSONArray restore = new JSONArray().put(new JSONObject().put("id", second).put("revision", trashed.getString("mutationRevision")));
      JSObject batch = library.changeMany("restore", restore, () -> false);
      assertEquals("complete", batch.getString("status"));
      JSONObject current = library.metadata(second, false);
      JSONArray trash = new JSONArray().put(new JSONObject().put("id", second).put("revision", current.getString("mutationRevision")));
      assertEquals("complete", library.changeMany("trash", trash, () -> false).getString("status"));
      JSONObject inTrash = library.metadata(second, true);
      JSObject prepared =
          library.prepareDeleteTrash(
              new JSONArray().put(new JSONObject().put("id", second).put("revision", inTrash.getString("mutationRevision"))));
      assertEquals(1, prepared.getInt("count"));
      JSObject removed = library.deletePreparedTrash(prepared.getString("confirmation"), () -> false);
      assertEquals("deleted", removed.getString("status"));
      created.remove(second);
      try {
        library.deletePreparedTrash(prepared.getString("confirmation"), () -> false);
        fail("confirmation replayed");
      } catch (IllegalStateException expired) {
        assertTrue(expired.getMessage().startsWith("Delete confirmation expired"));
      }
      JSObject counts = library.summary();
      assertTrue(counts.getInt("favorites") >= 1);
    } finally {
      for (String id : created) resolver.delete(OwnedMediaLibrary.uri(id), null, null);
    }
  }
}
