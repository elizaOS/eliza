package ai.eliza.plugins.media;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Base64;
import org.json.JSONObject;

/**
 * Publishes explicitly kept captures with a durable operation identity. Call from one serial
 * worker.
 */
public final class OwnedCaptures {
  public static final class Result {
    public final boolean saved;
    public final String id, message;
    private Result(boolean saved, String id, String message) {
      this.saved = saved;
      this.id = id;
      this.message = message;
    }
  }
  private final ContentResolver resolver;
  private final SharedPreferences kept;
  private final OwnedMediaConfig config;
  private final String owner;

  public OwnedCaptures(Context context, OwnedMediaConfig config) {
    this.config = config;
    resolver = context.getContentResolver();
    owner = context.getPackageName();
    kept = context.getSharedPreferences(config.preferences("kept-captures"), 0);
  }

  private void persist(String operation, JSONObject receipt) throws IOException {
    String previous = kept.getString(operation, null);
    if (!kept.edit().putString(operation, receipt.toString()).commit()) {
      // SharedPreferences updates its process cache before disk I/O, even when commit fails.
      // Restore the prior state so a later retry cannot trust an uncommitted terminal receipt.
      SharedPreferences.Editor restore = kept.edit();
      if (previous == null)
        restore.remove(operation);
      else
        restore.putString(operation, previous);
      restore.commit();
      throw new IOException("Capture receipt could not be persisted");
    }
  }

  private Result saved(String operation, JSONObject receipt, String id) throws Exception {
    JSONObject finished = new JSONObject(receipt.toString()).put("status", "saved").put("id", id);
    persist(operation, finished);
    return new Result(true, id, null);
  }

  private Cursor lookup(String operation) throws IOException {
    Cursor row = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        new String[] {"_id", "is_pending"},
        "owner_package_name=? AND _display_name=? AND relative_path=?",
        new String[] {owner, config.captureName(operation), config.captureRelativePath}, null);
    if (row == null)
      throw new IOException("Capture lookup is unavailable");
    return row;
  }

  /** Never inserts a second row for an operation whose first attempt was reserved. */
  private Result recover(String operation, JSONObject receipt, byte[] bytes) throws Exception {
    if (receipt.getString("status").equals("saved"))
      return new Result(true, receipt.getString("id"), null);
    if (receipt.getString("status").equals("failed"))
      return new Result(
          false, null, "The unfinished capture was removed. Capture it again to retry.");
    try (Cursor row = lookup(operation)) {
      if (!row.moveToFirst())
        throw new IOException("No capture found for the reserved operation");
      Uri uri =
          ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, row.getLong(0));
      boolean pending = row.getInt(1) != 0;
      if (row.moveToNext())
        throw new IOException("Ambiguous capture identity");
      if (pending) {
        if (resolver.delete(uri, "is_pending=1 AND owner_package_name=?", new String[] {owner})
            != 1)
          throw new IOException("Capture cleanup was not confirmed");
        JSONObject failed = new JSONObject(receipt.toString()).put("status", "failed");
        persist(operation, failed);
        return new Result(
            false, null, "The unfinished capture was removed. Capture it again to retry.");
      }
      try (InputStream in = resolver.openInputStream(uri)) {
        MediaBytes.verify(in, bytes);
      }
      return saved(operation, receipt, Long.toString(ContentUris.parseId(uri)));
    }
  }

  public Result keep(String operationId, String jpegBase64) {
    String operation = OwnedMediaConfig.operation(operationId);
    String previous = kept.getString(operation, null);
    // Receipts written by the original host implementation contain just the published item id.
    if (previous != null && previous.matches("[1-9][0-9]*"))
      return new Result(true, previous, null);
    byte[] bytes;
    try {
      bytes = CaptureAdmission.jpeg(jpegBase64);
    } catch (IllegalArgumentException invalid) {
      return new Result(false, null, invalid.getMessage());
    }
    JSONObject receipt = null;
    try {
      String digest =
          Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes));
      if (previous != null) {
        receipt = new JSONObject(previous);
        if (!receipt.getString("sha256").equals(digest))
          return new Result(
              false, null, "This capture identity already belongs to different image bytes.");
        return recover(operation, receipt, bytes);
      }
      receipt = new JSONObject().put("status", "reserved").put("sha256", digest);
      // Also recover copies made by hosts that only recorded an identity after publication.
      try (Cursor row = lookup(operation)) {
        if (row.moveToFirst())
          return recover(operation, receipt, bytes);
      }
      persist(operation, receipt);
      ContentValues values = new ContentValues();
      values.put(MediaStore.Images.Media.DISPLAY_NAME, config.captureName(operation));
      values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
      values.put(MediaStore.Images.Media.RELATIVE_PATH, config.captureRelativePath);
      values.put(MediaStore.Images.Media.IS_PENDING, 1);
      Uri created = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
      if (created == null)
        throw new IOException("Photo could not be created");
      try (OutputStream out = resolver.openOutputStream(created, "w")) {
        if (out == null)
          throw new IOException("Photo could not be opened");
        out.write(bytes);
      }
      try (InputStream in = resolver.openInputStream(created)) {
        MediaBytes.verify(in, bytes);
      }
      ContentValues published = new ContentValues();
      published.put(MediaStore.Images.Media.IS_PENDING, 0);
      if (resolver.update(created, published, null, null) != 1)
        throw new IOException("Photo publication was not confirmed");
      return saved(operation, receipt, Long.toString(ContentUris.parseId(created)));
    } catch (Exception error) {
      // Publication may have succeeded even if the provider or receipt write returned an error.
      // Resolve the reserved identity; never delete a published row or insert a replacement.
      if (receipt != null) {
        try {
          return recover(operation, receipt, bytes);
        } catch (Exception unresolved) { /* Keep the reservation for a later explicit retry. */
        }
      }
      return new Result(
          false, null, "Photo save could not be confirmed. Check Photos before trying again.");
    }
  }
}
