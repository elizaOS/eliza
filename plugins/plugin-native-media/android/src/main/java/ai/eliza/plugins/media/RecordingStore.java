package ai.eliza.plugins.media;

import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Durable, device-local recordings (for example voice notes) with encrypted metadata and
 * per-operation deletion receipts. No path, audio byte or credential crosses a JS bridge: only a
 * host's native recorder can hand a stopped clip to {@link #retain}, and renderers name recordings
 * by id.
 *
 * <p>Each recording is {@code <id>.audio} in a host directory that is excluded from backup. Its
 * metadata lives in the host's encrypted slot store under {@code <slotPrefix><id>}; an older
 * plaintext {@code <id>.json} file is migrated into the slot (only after the slot reads back) and
 * replaced by a marker, and a disagreeing pair keeps both copies and refuses.
 *
 * <p>Deletion is two-step and owner-fenced. {@code remove} moves a recording to the store's trash
 * under one operation identity; only that operation may {@code restore} it or {@code purge} its
 * bytes. Every answer is a durable receipt ({@code removed}, {@code restored}, {@code purged} or
 * {@code unknown}) committed with its effect in one metadata write, so a renderer that died
 * mid-operation can ask again. A retired operation never regains permission: an operation that
 * restored a recording cannot remove it again, and a purged recording cannot be restored. The
 * owner field (for example {@code noteId}) must match on every change.
 *
 * <p>Every method serializes on one process-wide lock shared by the host's plugin, its recorders and
 * any background sweep. Installed hosts keep their directory, slot prefix and owner field names.
 */
public final class RecordingStore {
  /** The host's encrypted metadata store, for example a Keystore-backed slot store. */
  public interface Slots {
    /** The slot's value, or null when it was never written or was removed. */
    String read(String slot) throws Exception;

    void write(String slot, String value) throws Exception;

    void remove(String slot) throws Exception;
  }

  public static final String UNKNOWN = "unknown";
  public static final String REMOVED = "removed";
  public static final String RESTORED = "restored";
  public static final String PURGED = "purged";
  /** Largest stored clip. */
  public static final long MAX_BYTES = 4L * 1024 * 1024;
  /** Longest stored clip, in milliseconds. */
  public static final long MAX_DURATION_MS = 60_000;
  /** Longest stored transcript, in UTF-16 units. */
  public static final int MAX_TRANSCRIPT = 64_000;
  /** Receipts kept per recording; a new operation beyond this is refused, never evicted. */
  public static final int MAX_OPERATIONS = 128;
  /**
   * A trashed recording can be restored for this long; older trash from before operation receipts
   * existed is erased by {@link #migrateLegacy}.
   */
  public static final long RESTORE_WINDOW_MS = 30L * 24 * 60 * 60 * 1000;

  private static final int LEGACY_METADATA_BYTES = 512 * 1024;
  private static final byte[] MARKER = "{\"encrypted\":1}".getBytes(StandardCharsets.UTF_8);
  private static final Object LOCK = new Object();
  private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{1,100}");
  private static final Pattern OPERATION =
      Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
  private static final Pattern SLOT_PREFIX = Pattern.compile("[a-z][a-z0-9:._-]{0,63}");
  private static final Pattern FIELD = Pattern.compile("[a-z][A-Za-z0-9]{0,31}");

  private final File directory;
  private final String slotPrefix;
  private final String ownerField;
  private final Slots slots;
  private final LongSupplier clock;

  /**
   * @param directory the host's private recording directory (for example under {@code
   *     getNoBackupFilesDir()}); created on first use
   * @param slotPrefix the metadata slot name prefix, for example {@code "note-audio-metadata:v1:"}
   * @param ownerField the metadata field naming the item that owns each recording, for example
   *     {@code "noteId"}
   */
  public RecordingStore(File directory, String slotPrefix, String ownerField, Slots slots) {
    this(directory, slotPrefix, ownerField, slots, System::currentTimeMillis);
  }

  RecordingStore(
      File directory, String slotPrefix, String ownerField, Slots slots, LongSupplier clock) {
    if (directory == null
        || slots == null
        || clock == null
        || slotPrefix == null
        || !SLOT_PREFIX.matcher(slotPrefix).matches()
        || ownerField == null
        || !FIELD.matcher(ownerField).matches()
        || ownerField.equals("audioId"))
      throw new IllegalArgumentException("Invalid recording store configuration");
    this.directory = directory;
    this.slotPrefix = slotPrefix;
    this.ownerField = ownerField;
    this.slots = slots;
    this.clock = clock;
  }

  /** A recording or owner id: 1-100 letters, digits, '_' or '-'. */
  public static String id(String value) {
    if (value == null || !ID.matcher(value).matches()) throw new IllegalArgumentException();
    return value;
  }

  /** A deletion operation identity: a lowercase UUID. */
  public static String operation(String value) {
    if (value == null || !OPERATION.matcher(value).matches()) throw new IllegalArgumentException();
    return value;
  }

  public static boolean isOperation(String value) {
    return value != null && OPERATION.matcher(value).matches();
  }

  private File directory() {
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException();
    return directory;
  }

  /** The stored clip of a recording (which may not exist). */
  public File audio(String value) {
    return new File(directory(), id(value) + ".audio");
  }

  private AtomicFile metadata(String value) {
    return new AtomicFile(new File(directory(), id(value) + ".json"));
  }

  private String slot(String value) {
    return slotPrefix + id(value);
  }

  private void write(String value, JSONObject record) throws Exception {
    String serialized = record.toString();
    slots.write(slot(value), serialized);
    if (!serialized.equals(slots.read(slot(value))))
      throw new IOException("Recording metadata commit unconfirmed");
    // Only replace the legacy file after durable encrypted storage has been read back.
    atomic(metadata(value), MARKER);
  }

  private JSONObject read(String value) throws Exception {
    String encrypted = slots.read(slot(value));
    JSONObject legacy = null;
    AtomicFile metadata = metadata(value);
    if (metadata.getBaseFile().exists() || new File(metadata.getBaseFile() + ".bak").exists()) {
      try (InputStream in = metadata.openRead()) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        copyBounded(in, bytes, LEGACY_METADATA_BYTES);
        legacy = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
      }
    }
    if (legacy != null && !legacy.has("encrypted")) {
      String original = legacy.toString();
      if (encrypted != null && !encrypted.equals(original))
        throw new IOException("Recording metadata copies disagree; originals retained");
      write(value, legacy);
      return legacy;
    }
    if (encrypted == null) throw new IOException("Recording metadata unavailable");
    return new JSONObject(encrypted);
  }

  private static void copyBounded(InputStream in, OutputStream out, long limit) throws IOException {
    byte[] buffer = new byte[8192];
    long total = 0;
    int count;
    while ((count = in.read(buffer)) != -1) {
      if (count > limit - total) throw new IOException("Recording data exceeds limit");
      out.write(buffer, 0, count);
      total += count;
    }
  }

  private static void atomic(AtomicFile file, byte[] bytes) throws Exception {
    FileOutputStream out = null;
    try {
      out = file.startWrite();
      out.write(bytes);
      file.finishWrite(out);
    } catch (Exception error) {
      if (out != null) file.failWrite(out);
      throw error;
    }
  }

  /** The recording's metadata. */
  public JSONObject describe(String value) throws Exception {
    synchronized (LOCK) {
      return read(id(value));
    }
  }

  /**
   * Imports a stopped native recording (at most {@link #MAX_BYTES}, 1 ms to {@link
   * #MAX_DURATION_MS}) or updates the transcript of one already stored for the same owner. The
   * clip is copied to a pending file, synced and renamed into place before its metadata is
   * committed. An id whose recording was deleted under a receipt is retired and refused.
   */
  public JSONObject retain(
      File source, String recordingId, String ownerId, long durationMs, String transcript)
      throws Exception {
    synchronized (LOCK) {
      id(recordingId);
      id(ownerId);
      if (source == null
          || !source.isFile()
          || source.length() < 1
          || source.length() > MAX_BYTES
          || durationMs < 1
          || durationMs > MAX_DURATION_MS
          || transcript == null
          || transcript.length() > MAX_TRANSCRIPT)
        throw new IOException();
      File target = audio(recordingId);
      JSONObject record;
      if (!target.isFile()
          && slots.read(slot(recordingId)) != null
          && read(recordingId).has("deletionOperations"))
        throw new IOException("Recording identity retired");
      if (target.isFile()
          && (metadata(recordingId).getBaseFile().isFile()
              || slots.read(slot(recordingId)) != null)) {
        record = read(recordingId);
        if (!ownerId.equals(record.optString(ownerField)) || record.optLong("deletedAt", 0) > 0)
          throw new IOException();
      } else {
        File temp = new File(directory(), recordingId + ".pending");
        try (InputStream in = new FileInputStream(source);
            FileOutputStream out = new FileOutputStream(temp)) {
          copyBounded(in, out, MAX_BYTES);
          out.getFD().sync();
        } catch (Exception error) {
          temp.delete();
          throw error;
        }
        if (!temp.renameTo(target)) {
          temp.delete();
          throw new IOException();
        }
        record = new JSONObject();
        record.put("audioId", recordingId);
        record.put(ownerField, ownerId);
        record.put("durationMs", durationMs);
        record.put("createdAt", clock.getAsLong());
        record.put("mimeType", "audio/mp4");
      }
      record.put("transcript", transcript);
      write(recordingId, record);
      return record;
    }
  }

  /** The clip of a recording that is stored and not in the store's trash. */
  public File playable(String value) throws Exception {
    synchronized (LOCK) {
      String key = id(value);
      if (read(key).optLong("deletedAt", 0) > 0) throw new IOException("Recording deleted");
      File file = audio(key);
      if (!file.isFile()) throw new IOException("Recording unavailable");
      return file;
    }
  }

  /** A receipt: operation, recording, owner and status. */
  public JSONObject receipt(JSONObject record, String operation, String status) throws Exception {
    JSONObject result = new JSONObject();
    result.put("operationId", operation);
    result.put("audioId", record.getString("audioId"));
    result.put(ownerField, record.getString(ownerField));
    result.put("status", status);
    return result;
  }

  private JSONObject owned(String value, String ownerId) throws Exception {
    JSONObject record = read(id(value));
    if (!record.getString(ownerField).equals(id(ownerId))) throw new IOException();
    return record;
  }

  private static String prior(JSONObject record, String operation) {
    JSONObject receipts = record.optJSONObject("deletionOperations");
    return receipts == null ? UNKNOWN : receipts.optString(operation, UNKNOWN);
  }

  /** Moves a recording to the store's trash under {@code operation}. */
  public JSONObject remove(String value, String ownerId, String operation, Runnable beforeEffect)
      throws Exception {
    return changeDeleted(value, ownerId, operation, true, beforeEffect);
  }

  /** Brings back a recording this operation trashed (or legacy trash with no receipts). */
  public JSONObject restore(String value, String ownerId, String operation, Runnable beforeEffect)
      throws Exception {
    return changeDeleted(value, ownerId, operation, false, beforeEffect);
  }

  /**
   * @param beforeEffect runs (under the lock) only when the change is admitted, just before it is
   *     applied; hosts stop playback of this recording there
   */
  private JSONObject changeDeleted(
      String value, String ownerId, String operation, boolean deleted, Runnable beforeEffect)
      throws Exception {
    synchronized (LOCK) {
      String key = id(value);
      operation(operation);
      JSONObject record = owned(key, ownerId);
      JSONObject receipts = record.optJSONObject("deletionOperations");
      if (receipts == null) receipts = new JSONObject();
      String prior = receipts.optString(operation, UNKNOWN);
      // Retired operations never regain permission to delete, even after renderer death.
      if (prior.equals(RESTORED) || (deleted && (prior.equals(REMOVED) || prior.equals(PURGED))))
        return receipt(record, operation, prior);
      if (prior.equals(PURGED)) throw new IOException("Recording erased");
      if (!receipts.has(operation) && receipts.length() >= MAX_OPERATIONS)
        throw new IOException("Recording operation history full");
      boolean legacyRestore =
          !deleted
              && record.optLong("deletedAt", 0) > 0
              && !record.has("activeDeletionOperation")
              && !record.has("deletionOperations");
      if (record.has("deletedAt")
          && !operation.equals(record.optString("activeDeletionOperation"))
          && !legacyRestore) throw new IOException("Another deletion owns recording");
      long now = clock.getAsLong();
      if (!deleted
          && record.optLong("deletedAt", 0) > 0
          && now - record.getLong("deletedAt") > RESTORE_WINDOW_MS)
        throw new IOException("Recording expired");
      if (beforeEffect != null) beforeEffect.run();
      if (deleted) {
        record.put("deletedAt", now);
        record.put("activeDeletionOperation", operation);
      } else {
        if (!audio(key).isFile()) throw new IOException();
        record.remove("deletedAt");
        record.remove("activeDeletionOperation");
      }
      String status = deleted ? REMOVED : RESTORED;
      receipts.put(operation, status);
      record.put("deletionOperations", receipts);
      // Receipt and effect share one encrypted metadata commit. No replay tombstone eviction.
      write(key, record);
      return receipt(record, operation, status);
    }
  }

  /**
   * Erases the clip of a recording this operation already moved to the store's trash; the
   * metadata stays as the receipt and the transcript is cleared. A restored recording is never
   * purged and only the operation that owns the current trash may erase it.
   */
  public JSONObject purge(String value, String ownerId, String operation, Runnable beforeEffect)
      throws Exception {
    synchronized (LOCK) {
      String key = id(value);
      operation(operation);
      JSONObject record = owned(key, ownerId);
      String prior = prior(record, operation);
      if (prior.equals(PURGED)) return receipt(record, operation, prior);
      if (!prior.equals(REMOVED)
          || record.optLong("deletedAt", 0) <= 0
          || !operation.equals(record.optString("activeDeletionOperation")))
        throw new IOException("Recording is not in this deletion");
      if (beforeEffect != null) beforeEffect.run();
      erase(key, record, operation);
      return receipt(record, operation, PURGED);
    }
  }

  private void erase(String key, JSONObject record, String operation) throws Exception {
    File bytes = audio(key);
    if (bytes.exists() && !bytes.delete()) throw new IOException("Recording bytes retained");
    JSONObject receipts = record.getJSONObject("deletionOperations");
    record.put("transcript", "");
    receipts.put(operation, PURGED);
    record.put("deletionOperations", receipts);
    write(key, record);
  }

  /** The receipt this operation holds for the recording, {@code unknown} when it holds none. */
  public JSONObject deletionStatus(String value, String ownerId, String operation)
      throws Exception {
    synchronized (LOCK) {
      JSONObject record = owned(value, ownerId);
      return receipt(record, operation(operation), prior(record, operation));
    }
  }

  /**
   * Background form of {@link #purge}: true only when the clip is confirmed erased under this
   * operation (now or before). Never throws; any refusal or unreadable state is false.
   */
  public boolean purgeTrashed(String value, String ownerId, String operation) {
    synchronized (LOCK) {
      try {
        if (!isOperation(operation)) return false;
        JSONObject record = read(id(value));
        if (!ownerId.equals(record.optString(ownerField))) return false;
        String prior = prior(record, operation);
        if (prior.equals(PURGED)) return true;
        if (!prior.equals(REMOVED)
            || record.optLong("deletedAt", 0) <= 0
            || !operation.equals(record.optString("activeDeletionOperation"))) return false;
        erase(value, record, operation);
        return true;
      } catch (Exception retained) {
        return false;
      }
    }
  }

  /**
   * Finishes a permanent deletion (no restorable trash) that the host already committed for this
   * owner, with the same receipts as {@link #remove} then {@link #purge}. A recording never moved
   * is moved under this operation first; one that another deletion holds, or with any other
   * receipt, is left alone. True only when the clip is confirmed erased under this operation.
   * Never throws.
   */
  public boolean finishPermanent(String value, String ownerId, String operation, long now) {
    synchronized (LOCK) {
      try {
        if (!isOperation(operation)) return false;
        JSONObject record = read(id(value));
        if (!value.equals(record.optString("audioId"))
            || !ownerId.equals(record.optString(ownerField))) return false;
        JSONObject receipts = record.optJSONObject("deletionOperations");
        String prior = receipts == null ? UNKNOWN : receipts.optString(operation, UNKNOWN);
        if (prior.equals(UNKNOWN)) {
          // Never moved. A recording already in the store's trash belongs to another deletion.
          if (record.has("deletedAt") || record.has("activeDeletionOperation")) return false;
          if (receipts == null) receipts = new JSONObject();
          if (receipts.length() >= MAX_OPERATIONS) return false;
          record.put("deletedAt", now);
          record.put("activeDeletionOperation", operation);
          receipts.put(operation, REMOVED);
          record.put("deletionOperations", receipts);
          write(value, record);
        } else if (!prior.equals(REMOVED) && !prior.equals(PURGED)) return false;
        return purgeTrashed(value, ownerId, operation);
      } catch (Exception retained) {
        return false;
      }
    }
  }

  /**
   * One startup pass over stored metadata: migrates each legacy plaintext record into the
   * encrypted store and erases legacy trash older than {@link #RESTORE_WINDOW_MS}. A legacy
   * recording with no receipts loses its metadata too; one with receipts keeps them and only its
   * transcript is cleared. Each record is handled under the lock on its own, so the pass never
   * holds the lock across the collection, and an unreadable record is kept for recovery.
   *
   * @param stopped polled between records; the pass returns early once it is true
   * @return the number of records that could not be handled
   * @throws IOException when the directory cannot be listed
   */
  public int migrateLegacy(BooleanSupplier stopped) throws IOException {
    File[] records = directory().listFiles((dir, name) -> name.endsWith(".json"));
    if (records == null) throw new IOException("Recording directory unavailable");
    int failures = 0;
    for (File record : records) {
      if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted()) return failures;
      try {
        synchronized (LOCK) {
          if (stopped.getAsBoolean()) return failures;
          String key = record.getName().substring(0, record.getName().length() - 5);
          JSONObject value = read(key);
          long deleted = value.optLong("deletedAt", 0);
          if (deleted > 0 && clock.getAsLong() - deleted > RESTORE_WINDOW_MS) {
            if (!audio(key).exists() || audio(key).delete()) {
              if (!value.has("deletionOperations")) {
                slots.remove(slot(key));
                metadata(key).delete();
              } else {
                value.put("transcript", "");
                write(key, value);
              }
            }
          }
        }
      } catch (Exception retained) {
        // Keep both copies; the host reports that recovery is needed.
        failures++;
      }
    }
    return failures;
  }
}
