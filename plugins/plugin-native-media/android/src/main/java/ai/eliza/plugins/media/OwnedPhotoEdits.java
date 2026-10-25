package ai.eliza.plugins.media;
import android.content.*;
import android.database.Cursor;
import android.graphics.*;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.*;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Serial-worker edit sessions over the host's own published still photos. No arbitrary URIs,
 * uploads or original writes: an edit is a new owned PNG copy with a crash-safe receipt journal.
 * The host supplies storage namespace and MediaStore placement through {@link OwnedMediaConfig}.
 */
public final class OwnedPhotoEdits {
  private final Context context;
  private final ContentResolver resolver;
  private final SharedPreferences journal;
  private final OwnedMediaConfig config;
  private volatile Session active;
  private static final int MAX_EDGE = 2048;
  private static final class Session {
    String token, id, revision;
    byte[] digest;
    Bitmap pixels;
    volatile boolean cancelled;
    boolean reduced;
  }
  public OwnedPhotoEdits(Context c, OwnedMediaConfig config) {
    context = c;
    this.config = config;
    resolver = c.getContentResolver();
    journal = c.getSharedPreferences(config.preferences("photo-edit-results"), 0);
  }
  private Uri source(String id) {
    if (id == null || !id.matches("[1-9][0-9]*"))
      throw new IllegalArgumentException("Only saved still photos can be edited");
    return ContentUris.withAppendedId(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Long.parseLong(id));
  }
  private String revision(String id) throws Exception {
    String[] fields = Build.VERSION.SDK_INT >= 30
        ? new String[] {"date_added", "_size", "generation_modified", "is_trashed"}
        : new String[] {"date_added", "_size"};
    try (Cursor row = resolver.query(source(id), fields,
             "owner_package_name=? AND is_pending=0"
                 + (Build.VERSION.SDK_INT >= 30 ? " AND is_trashed=0" : ""),
             new String[] {context.getPackageName()}, null)) {
      if (row == null || !row.moveToFirst())
        throw new IllegalArgumentException("Photo no longer available. Reload Photos.");
      if (row.getLong(1) > 32L * 1024 * 1024)
        throw new IllegalArgumentException("Edit copies support source files up to 32 MB");
      return row.getLong(0) + ":" + row.getLong(1)
          + (Build.VERSION.SDK_INT >= 30 ? ":" + row.getLong(2) + ":" + row.getInt(3) : "");
    }
  }
  private byte[] bytes(String id) throws Exception {
    try (InputStream input = resolver.openInputStream(source(id));
        ByteArrayOutputStream output = new ByteArrayOutputStream()) {
      if (input == null)
        throw new IOException();
      byte[] chunk = new byte[16384];
      int n;
      while ((n = input.read(chunk)) != -1) {
        if (output.size() + n > 32 * 1024 * 1024)
          throw new IllegalArgumentException("Edit copies support source files up to 32 MB");
        output.write(chunk, 0, n);
      }
      return output.toByteArray();
    }
  }
  private byte[] digest(String id) throws Exception {
    java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
    try (InputStream input = resolver.openInputStream(source(id))) {
      if (input == null)
        throw new IOException();
      byte[] buffer = new byte[16384];
      int n, total = 0;
      while ((n = input.read(buffer)) != -1) {
        total += n;
        if (total > 32 * 1024 * 1024)
          throw new IOException();
        hash.update(buffer, 0, n);
      }
    }
    return hash.digest();
  }
  private void current(Session s) throws Exception {
    if (s == null || s.cancelled || active != s)
      throw new IllegalArgumentException("Photo editor closed");
    if (!s.revision.equals(revision(s.id)) || !java.util.Arrays.equals(s.digest, digest(s.id)))
      throw new IllegalArgumentException("Photo changed. Cancel and reopen the editor.");
  }
  public JSObject begin(String id, String expected) throws Exception {
    close();
    String before = revision(id);
    if (expected == null || !expected.equals(before))
      throw new IllegalArgumentException("Photo changed. Reload Photos.");
    Session s = new Session();
    s.id = id;
    s.revision = before;
    s.token = UUID.randomUUID().toString();
    byte[] snapshot = bytes(id);
    s.digest = java.security.MessageDigest.getInstance("SHA-256").digest(snapshot);
    Bitmap pixels = ImageDecoder.decodeBitmap(
        ImageDecoder.createSource(java.nio.ByteBuffer.wrap(snapshot)), (decoder, info, src) -> {
          if (info.isAnimated())
            throw new IllegalArgumentException("Animated images cannot be edited here");
          int width = info.getSize().getWidth(), height = info.getSize().getHeight();
          double scale = Math.min(1d, MAX_EDGE / (double) Math.max(width, height));
          s.reduced = scale < 1;
          decoder.setTargetSize(Math.max(1, (int) Math.round(width * scale)),
              Math.max(1, (int) Math.round(height * scale)));
          decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
          decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB));
        });
    s.pixels = pixels;
    active = s;
    try {
      current(s);
      return preview(s.token, 0, false, "none");
    } catch (Exception error) {
      close();
      throw error;
    }
  }
  private Session session(String token) throws Exception {
    Session s = active;
    if (s == null || !s.token.equals(token))
      throw new IllegalArgumentException("Photo edit session expired");
    current(s);
    return s;
  }
  private Bitmap geometry(Session s, int rotation, boolean crop) {
    if (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270)
      throw new IllegalArgumentException("Use a quarter-turn rotation");
    Matrix matrix = new Matrix();
    matrix.postRotate(rotation);
    Bitmap rotated = Bitmap.createBitmap(
        s.pixels, 0, 0, s.pixels.getWidth(), s.pixels.getHeight(), matrix, false);
    if (!crop)
      return rotated;
    int width = Math.max(1, (int) Math.floor(rotated.getWidth() / 1.3)),
        height = Math.max(1, (int) Math.floor(rotated.getHeight() / 1.3));
    Bitmap result = Bitmap.createBitmap(rotated, (rotated.getWidth() - width) / 2,
        (rotated.getHeight() - height) / 2, width, height);
    if (rotated != s.pixels && rotated != result)
      rotated.recycle();
    return result;
  }
  private Bitmap transform(Session s, int rotation, boolean crop, String filter) {
    Bitmap geometry = geometry(s, rotation, crop);
    try {
      Bitmap output = PhotoFilter.apply(geometry, filter, () -> s.cancelled);
      if (output != geometry && geometry != s.pixels)
        geometry.recycle();
      return output;
    } catch (RuntimeException e) {
      if (geometry != s.pixels)
        geometry.recycle();
      throw e;
    }
  }
  public JSObject preview(String token, int rotation, boolean crop, String filter)
      throws Exception {
    Session s = session(token);
    Bitmap bitmap = transform(s, rotation, crop, filter), small = bitmap;
    try {
      double scale = Math.min(1d, 1024d / Math.max(bitmap.getWidth(), bitmap.getHeight()));
      if (scale < 1)
        small = Bitmap.createScaledBitmap(bitmap, Math.max(1, (int) (bitmap.getWidth() * scale)),
            Math.max(1, (int) (bitmap.getHeight() * scale)), true);
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      if (!small.compress(Bitmap.CompressFormat.PNG, 100, out))
        throw new IOException();
      current(s);
      JSObject value = new JSObject();
      value.put("sessionId", token);
      value.put("operationId", token);
      value.put("image",
          "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
      value.put("width", bitmap.getWidth());
      value.put("height", bitmap.getHeight());
      value.put("reduced", s.reduced);
      value.put("maxEdge", MAX_EDGE);
      value.put("filter", filter);
      return value;
    } finally {
      if (small != bitmap && small != s.pixels)
        small.recycle();
      if (bitmap != s.pixels)
        bitmap.recycle();
    }
  }
  private String name(String token) {
    return config.editName(token);
  }
  private JSObject receipt(String status, String token, Uri uri) {
    JSObject out = new JSObject();
    out.put("status", status);
    out.put("operationId", token);
    if (uri != null)
      out.put("id", Long.toString(ContentUris.parseId(uri)));
    return out;
  }
  public JSObject result(String token) throws Exception {
    name(token);
    String record = journal.getString(token, null);
    if (record == null)
      return receipt("not-started", token, null);
    JSONObject saved = new JSONObject(record);
    boolean published = saved.optString("status").equals("saved");
    String savedId = saved.optString("id", null);
    if (published && savedId != null)
      return receipt("saved", token, source(savedId));
    // The deterministic owned display name closes publish→receipt crash ambiguity.
    try (Cursor row = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
             new String[] {"_id", "is_pending"}, "owner_package_name=? AND _display_name=?",
             new String[] {context.getPackageName(), name(token)}, null)) {
      if (row == null)
        throw new IOException("Saved-copy lookup is unavailable");
      if (row.moveToFirst()) {
        Uri copy = ContentUris.withAppendedId(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, row.getLong(0));
        if (row.moveToNext())
          throw new IllegalStateException("Ambiguous saved copy; inspect Photos before retrying");
        row.moveToFirst();
        if (row.getInt(1) == 0) {
          saved.put("status", "saved").put("id", Long.toString(ContentUris.parseId(copy)));
          if (!journal.edit().putString(token, saved.toString()).commit())
            throw new IOException("Saved-copy receipt could not be persisted");
          return receipt("saved", token, copy);
        }
        // A previously confirmed save remains a historical success, even if its item changed.
        if (published)
          return receipt("saved", token, null);
        if (resolver.delete(copy, "is_pending=1", null) != 1)
          throw new IOException("Pending copy cleanup was not confirmed");
        saved.put("status", "failed");
        if (!journal.edit().putString(token, saved.toString()).commit())
          throw new IOException();
        return receipt("failed", token, null);
      }
    }
    if (published)
      return receipt("saved", token, null);
    saved.put("status", "failed");
    if (!journal.edit().putString(token, saved.toString()).commit())
      throw new IOException();
    return receipt("failed", token, null);
  }
  public JSObject save(String token, int rotation, boolean crop, String filter) throws Exception {
    PhotoFilter.validate(filter);
    Session s = session(token);
    String existing = journal.getString(token, null);
    if (existing != null) {
      JSONObject previous = new JSONObject(existing);
      if (previous.getInt("rotation") != rotation || previous.getBoolean("crop") != crop
          || !previous.optString("filter", "none").equals(filter))
        throw new IllegalArgumentException("This save identity already has a different edit");
      return result(token);
    }
    if (rotation == 0 && !crop && filter.equals("none"))
      return receipt("unchanged", token, null);
    JSONObject saveReceipt = new JSONObject()
                                 .put("status", "incomplete")
                                 .put("createdAt", System.currentTimeMillis())
                                 .put("rotation", rotation)
                                 .put("crop", crop)
                                 .put("filter", filter);
    if (!journal.edit().putString(token, saveReceipt.toString()).commit())
      throw new IOException("Save receipt could not be reserved");
    Bitmap bitmap = null;
    Uri copy = null;
    try {
      bitmap = transform(s, rotation, crop, filter);
      current(s);
      ContentValues values = new ContentValues();
      values.put(MediaStore.Images.Media.DISPLAY_NAME, name(token));
      values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
      values.put(MediaStore.Images.Media.RELATIVE_PATH, config.editRelativePath);
      values.put(MediaStore.Images.Media.IS_PENDING, 1);
      values.put(MediaStore.Images.Media.WIDTH, bitmap.getWidth());
      values.put(MediaStore.Images.Media.HEIGHT, bitmap.getHeight());
      copy = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
      if (copy == null)
        throw new IOException("Copy could not be created");
      try (OutputStream output = resolver.openOutputStream(copy, "w")) {
        if (output == null || !bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
          throw new IOException("Copy could not be written");
        output.flush();
      }
      current(s);
      values = new ContentValues();
      values.put(MediaStore.Images.Media.IS_PENDING, 0);
      if (resolver.update(copy, values, null, null) != 1)
        throw new IOException("Copy publication was not confirmed");
      // Never delete a published copy merely because its receipt write failed.
      saveReceipt.put("status", "saved").put("id", Long.toString(ContentUris.parseId(copy)));
      journal.edit().putString(token, saveReceipt.toString()).commit();
      return receipt("saved", token, copy);
    } catch (Exception failure) {
      if (copy != null) {
        try (Cursor row = resolver.query(copy, new String[] {"is_pending"}, null, null, null)) {
          if (row != null && row.moveToFirst() && row.getInt(0) == 1)
            resolver.delete(copy, null, null);
        }
      }
      throw failure;
    } finally {
      if (bitmap != null && bitmap != s.pixels)
        bitmap.recycle();
    }
  }
  public void cancel(String token) {
    Session s = active;
    if (s != null && (token == null || s.token.equals(token)))
      s.cancelled = true;
  }
  public void close() {
    Session s = active;
    active = null;
    if (s != null) {
      s.cancelled = true;
      if (s.pixels != null && !s.pixels.isRecycled())
        s.pixels.recycle();
    }
  }
  public void releaseCancelled() {
    Session s = active;
    if (s != null && s.cancelled)
      close();
  }
}
