package example.ownedmedia;

import static org.junit.Assert.*;

import ai.eliza.plugins.media.*;
import android.content.*;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.lang.reflect.Proxy;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.Test;

public final class MediaConsumerTest {
  private static String hash(byte[] bytes) throws Exception {
    return Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes));
  }
  private static byte[] read(ContentResolver resolver, Uri uri) throws Exception {
    try (InputStream in = resolver.openInputStream(uri);
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      assertNotNull(in);
      byte[] buffer = new byte[8192];
      int length;
      while ((length = in.read(buffer)) != -1) out.write(buffer, 0, length);
      return out.toByteArray();
    }
  }
  private static Uri item(String id) {
    return ContentUris.withAppendedId(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Long.parseLong(id));
  }
  private static int count(ContentResolver resolver, String owner) {
    try (Cursor rows = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
             new String[] {"_id"}, "owner_package_name=?", new String[] {owner}, null)) {
      assertNotNull(rows);
      return rows.getCount();
    }
  }
  // Keep real SharedPreferences and MediaStore writes, but fail the acknowledgement of terminal
  // capture receipts. This exposes the framework's cache-before-disk-commit behavior.
  private static Context failSavedReceipt(Context context, AtomicBoolean fail) {
    return new ContextWrapper(context) {
      @Override
      public SharedPreferences getSharedPreferences(String name, int mode) {
        SharedPreferences delegate = context.getSharedPreferences(name, mode);
        return (SharedPreferences) Proxy.newProxyInstance(SharedPreferences.class.getClassLoader(),
            new Class<?>[] {SharedPreferences.class}, (proxy, method, args) -> {
              if (!method.getName().equals("edit"))
                return method.invoke(delegate, args);
              SharedPreferences.Editor editor = delegate.edit();
              AtomicBoolean terminal = new AtomicBoolean();
              return Proxy.newProxyInstance(SharedPreferences.Editor.class.getClassLoader(),
                  new Class<?>[] {SharedPreferences.Editor.class},
                  (editProxy, editMethod, editArgs) -> {
                    if (editMethod.getName().equals("putString"))
                      terminal.set(String.valueOf(editArgs[1]).contains("\"status\":\"saved\""));
                    Object result = editMethod.invoke(editor, editArgs);
                    if (editMethod.getName().equals("commit") && terminal.get() && fail.get())
                      return false;
                    return result instanceof SharedPreferences.Editor ? editProxy : result;
                  });
            });
      }
    };
  }

  @Test
  public void keepRecoverAndEditRealOwnedMedia() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    ContentResolver resolver = context.getContentResolver();
    String namespace = "fixture" + UUID.randomUUID().toString().replace("-", "");
    OwnedMediaConfig config = OwnedMediaConfig.builder(namespace)
                                  .edits("Pictures/OwnedMediaTest/Edits/", "edit-")
                                  .captures("Pictures/OwnedMediaTest/", "capture-")
                                  .build();
    SharedPreferences kept = context.getSharedPreferences(config.preferences("kept-captures"), 0);
    OwnedPhotoEdits edits = new OwnedPhotoEdits(context, config);
    Bitmap pixels = Bitmap.createBitmap(8, 4, Bitmap.Config.ARGB_8888);
    pixels.eraseColor(0xffff3300);
    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
    assertTrue(pixels.compress(Bitmap.CompressFormat.JPEG, 95, encoded));
    pixels.recycle();
    byte[] jpeg = encoded.toByteArray();
    String base64 = Base64.getEncoder().encodeToString(jpeg);
    int initial = count(resolver, context.getPackageName());
    try {
      String operation = UUID.randomUUID().toString();
      OwnedCaptures captures = new OwnedCaptures(context, config);
      OwnedCaptures.Result saved = captures.keep(operation, base64);
      assertTrue(saved.message, saved.saved);
      assertArrayEquals(jpeg, read(resolver, item(saved.id)));
      assertEquals(saved.id, captures.keep(operation, base64).id);
      assertEquals(initial + 1, count(resolver, context.getPackageName()));
      byte[] changed = jpeg.clone();
      changed[changed.length - 1] ^= 1;
      assertFalse(captures.keep(operation, Base64.getEncoder().encodeToString(changed)).saved);
      // Reconstruct the durable state after publication but before the final receipt.
      JSONObject receipt = new JSONObject(kept.getString(operation, null));
      receipt.put("status", "reserved");
      receipt.remove("id");
      assertTrue(kept.edit().putString(operation, receipt.toString()).commit());
      assertEquals(saved.id, new OwnedCaptures(context, config).keep(operation, base64).id);
      assertEquals(initial + 1, count(resolver, context.getPackageName()));

      // An older host may have published without reserving any receipt first.
      assertTrue(kept.edit().remove(operation).commit());
      assertEquals(saved.id, new OwnedCaptures(context, config).keep(operation, base64).id);
      assertEquals(initial + 1, count(resolver, context.getPackageName()));

      AtomicBoolean rejectReceipt = new AtomicBoolean(true);
      OwnedCaptures failing = new OwnedCaptures(failSavedReceipt(context, rejectReceipt), config);
      String uncertain = UUID.randomUUID().toString();
      assertFalse(failing.keep(uncertain, base64).saved);
      assertFalse(failing.keep(uncertain, base64).saved);
      assertEquals(initial + 2, count(resolver, context.getPackageName()));
      rejectReceipt.set(false);
      OwnedCaptures.Result recovered = failing.keep(uncertain, base64);
      assertTrue(recovered.message, recovered.saved);
      assertArrayEquals(jpeg, read(resolver, item(recovered.id)));
      assertEquals(initial + 2, count(resolver, context.getPackageName()));
      assertEquals(1, resolver.delete(item(recovered.id), null, null));

      String reservedOnly = UUID.randomUUID().toString();
      assertTrue(kept.edit()
              .putString(reservedOnly,
                  new JSONObject().put("status", "reserved").put("sha256", hash(jpeg)).toString())
              .commit());
      assertFalse(captures.keep(reservedOnly, base64).saved);
      assertFalse(captures.keep(reservedOnly, base64).saved);
      assertEquals(initial + 1, count(resolver, context.getPackageName()));

      String unfinished = UUID.randomUUID().toString();
      assertTrue(kept.edit()
              .putString(unfinished,
                  new JSONObject().put("status", "reserved").put("sha256", hash(jpeg)).toString())
              .commit());
      ContentValues pending = new ContentValues();
      pending.put("_display_name", config.captureName(unfinished));
      pending.put("mime_type", "image/jpeg");
      pending.put("relative_path", config.captureRelativePath);
      pending.put("is_pending", 1);
      Uri partial = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pending);
      assertNotNull(partial);
      try (OutputStream out = resolver.openOutputStream(partial, "w")) {
        out.write(jpeg, 0, 4);
      }
      assertFalse(captures.keep(unfinished, base64).saved);
      assertFalse(captures.keep(unfinished, base64).saved);
      assertEquals(initial + 1, count(resolver, context.getPackageName()));

      String revision;
      boolean modern = Build.VERSION.SDK_INT >= 30;
      String[] columns = modern
          ? new String[] {"date_added", "_size", "generation_modified", "is_trashed"}
          : new String[] {"date_added", "_size"};
      try (Cursor row = resolver.query(item(saved.id), columns, null, null, null)) {
        assertNotNull(row);
        assertTrue(row.moveToFirst());
        revision = OwnedMediaSelection.revision(Build.VERSION.SDK_INT, row.getLong(0),
            row.getLong(1), modern ? row.getLong(2) : 0, modern ? row.getInt(3) : 0);
      }
      String session = edits.begin(saved.id, revision).getString("sessionId");
      JSONObject preview = edits.preview(session, 90, false, "mono");
      assertEquals(4, preview.getInt("width"));
      assertEquals(8, preview.getInt("height"));
      // A new save must preserve older effect receipts instead of evicting them at 128.
      SharedPreferences history =
          context.getSharedPreferences(config.preferences("photo-edit-results"), 0);
      SharedPreferences.Editor seed = history.edit();
      for (int i = 0; i < 128; i++)
        seed.putString(
            "old-" + i, new JSONObject().put("status", "saved").put("createdAt", i).toString());
      assertTrue(seed.commit());
      JSONObject copy = edits.save(session, 90, false, "mono");
      assertEquals("saved", copy.getString("status"));
      assertEquals(copy.getString("id"), edits.save(session, 90, false, "mono").getString("id"));
      assertArrayEquals(jpeg, read(resolver, item(saved.id)));
      byte[] png = read(resolver, item(copy.getString("id")));
      Bitmap edited = BitmapFactory.decodeByteArray(png, 0, png.length);
      assertNotNull(edited);
      try {
        assertEquals(4, edited.getWidth());
        assertEquals(8, edited.getHeight());
        int pixel = edited.getPixel(0, 0);
        assertEquals(Color.red(pixel), Color.green(pixel));
        assertEquals(Color.green(pixel), Color.blue(pixel));
      } finally {
        edited.recycle();
      }
      assertEquals(129, history.getAll().size());
      assertEquals(initial + 2, count(resolver, context.getPackageName()));
      edits.close();
      assertEquals(copy.getString("id"),
          new OwnedPhotoEdits(context, config).result(session).getString("id"));
      assertEquals(1, resolver.delete(item(copy.getString("id")), null, null));
      JSONObject pastSave = new OwnedPhotoEdits(context, config).result(session);
      assertEquals("saved", pastSave.getString("status"));
      assertEquals(copy.getString("id"), pastSave.getString("id"));
      assertEquals(initial + 1, count(resolver, context.getPackageName()));
    } finally {
      edits.close();
      resolver.delete(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "owner_package_name=?",
          new String[] {context.getPackageName()});
      context.deleteSharedPreferences(config.preferences("kept-captures"));
      context.deleteSharedPreferences(config.preferences("photo-edit-results"));
    }
  }
}
