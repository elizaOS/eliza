package ai.eliza.plugins.media;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/**
 * Host-JVM checks of RecordingStore against a synthetic slot store, a temporary directory and the
 * AtomicFile test double. Not Android, Keystore or MediaPlayer evidence.
 */
public final class RecordingStoreTest {
  private static int checks;

  private static void check(boolean value, String label) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks + ": " + label);
  }

  private interface Failing {
    void run() throws Exception;
  }

  private static void rejects(Failing body, String label) {
    try {
      body.run();
    } catch (Exception expected) {
      checks++;
      return;
    }
    throw new AssertionError("Expected refusal: " + label);
  }

  static final class MemorySlots implements RecordingStore.Slots {
    final Map<String, String> values = new HashMap<>();
    boolean dropWrites;

    @Override
    public String read(String slot) {
      return values.get(slot);
    }

    @Override
    public void write(String slot, String value) {
      if (!dropWrites) values.put(slot, value);
    }

    @Override
    public void remove(String slot) {
      values.remove(slot);
    }
  }

  private static final String A = "00000000-0000-4000-8000-00000000000a";
  private static final String B = "00000000-0000-4000-8000-00000000000b";
  private static final long DAY = 24L * 60 * 60 * 1000;

  private static File clip(File dir, String name, int bytes) throws Exception {
    File file = new File(dir, name);
    Files.write(file.toPath(), new byte[bytes]);
    return file;
  }

  public static void main(String[] args) throws Exception {
    File root = Files.createTempDirectory("recording-store-").toFile();
    try {
      run(root);
    } finally {
      delete(root);
    }
    System.out.println("recording store checks: " + checks);
  }

  private static void delete(File file) {
    File[] children = file.listFiles();
    if (children != null) for (File child : children) delete(child);
    file.delete();
  }

  private static void run(File root) throws Exception {
    File dir = new File(root, "note-audio");
    MemorySlots slots = new MemorySlots();
    AtomicLong now = new AtomicLong(1_000_000_000_000L);
    RecordingStore store =
        new RecordingStore(dir, "note-audio-metadata:v1:", "noteId", slots, now::get);

    // Configuration is validated; the owner field cannot shadow the recording id.
    rejects(() -> new RecordingStore(dir, "Bad Prefix", "noteId", slots), "slot prefix");
    rejects(() -> new RecordingStore(dir, "p:", "audioId", slots), "owner field");
    rejects(() -> RecordingStore.id("../escape"), "path-like id");
    rejects(() -> RecordingStore.operation("not-a-uuid"), "operation identity");

    // Retain: bounded import, encrypted metadata committed after the clip is in place.
    File source = clip(root, "source.m4a", 32);
    rejects(() -> store.retain(source, "rec1", "note1", 0, "t"), "zero duration");
    rejects(() -> store.retain(source, "rec1", "note1", 60_001, "t"), "too long");
    rejects(() -> store.retain(clip(root, "empty.m4a", 0), "rec1", "note1", 10, "t"), "empty clip");
    rejects(
        () -> store.retain(source, "rec1", "note1", 10, "x".repeat(64_001)), "transcript bound");
    JSONObject saved = store.retain(source, "rec1", "note1", 2000, "First transcript");
    check(new File(dir, "rec1.audio").isFile(), "clip stored under the recording id");
    check(!new File(dir, "rec1.pending").exists(), "no pending file remains");
    check(saved.getString("noteId").equals("note1"), "owner recorded in the injected field");
    check(saved.getString("mimeType").equals("audio/mp4"), "mime type");
    check(saved.getLong("createdAt") == now.get(), "creation time from the clock");
    check(
        slots.values.get("note-audio-metadata:v1:rec1").equals(saved.toString()),
        "metadata lives in the encrypted slot");
    check(
        new String(Files.readAllBytes(new File(dir, "rec1.json").toPath()), StandardCharsets.UTF_8)
            .equals("{\"encrypted\":1}"),
        "the plaintext file is only a marker");
    JSONObject updated = store.retain(source, "rec1", "note1", 2000, "Edited transcript");
    check(updated.getString("transcript").equals("Edited transcript"), "transcript update");
    check(updated.getLong("createdAt") == saved.getLong("createdAt"), "same recording kept");
    rejects(() -> store.retain(source, "rec1", "other", 2000, "t"), "another owner's recording");
    check(store.describe("rec1").getString("transcript").equals("Edited transcript"), "describe");
    check(store.playable("rec1").getName().equals("rec1.audio"), "playable clip");

    // An unconfirmed slot commit is never reported as saved.
    slots.dropWrites = true;
    rejects(() -> store.retain(source, "rec2", "note2", 10, "t"), "unconfirmed metadata commit");
    slots.dropWrites = false;

    // Remove under A; the receipt and effect share one commit; replays answer the receipt.
    AtomicInteger stops = new AtomicInteger();
    Runnable stop = stops::incrementAndGet;
    rejects(() -> store.remove("rec1", "other", A, stop), "owner fence");
    check(stops.get() == 0, "a refused change never stops playback");
    JSONObject removed = store.remove("rec1", "note1", A, stop);
    check(removed.getString("status").equals("removed"), "removed receipt");
    check(removed.getString("noteId").equals("note1"), "receipt names the owner");
    check(removed.getString("operationId").equals(A), "receipt names the operation");
    check(stops.get() == 1, "playback stopped before the effect");
    check(store.remove("rec1", "note1", A, stop).getString("status").equals("removed"), "replay");
    check(stops.get() == 1, "a replay changes nothing");
    rejects(() -> store.playable("rec1"), "trashed recordings do not play");
    rejects(() -> store.remove("rec1", "note1", B, stop), "another deletion owns the recording");
    rejects(() -> store.restore("rec1", "note1", B, stop), "only the owning operation restores");
    check(
        store.deletionStatus("rec1", "note1", B).getString("status").equals("unknown"),
        "no receipt for another operation");

    // Restore under A; A is then retired and can never remove again.
    check(store.restore("rec1", "note1", A, stop).getString("status").equals("restored"), "restore");
    check(!store.describe("rec1").has("deletedAt"), "restored recording is live");
    check(
        store.remove("rec1", "note1", A, stop).getString("status").equals("restored"),
        "a retired operation never regains permission");
    check(store.describe("rec1").optLong("deletedAt", 0) == 0, "and changes nothing");

    // Purge needs the operation that owns the current trash.
    rejects(() -> store.purge("rec1", "note1", A, stop), "restored recordings are never purged");
    check(store.remove("rec1", "note1", B, stop).getString("status").equals("removed"), "B trash");
    rejects(() -> store.purge("rec1", "note1", A, stop), "A does not own B's trash");
    JSONObject purged = store.purge("rec1", "note1", B, stop);
    check(purged.getString("status").equals("purged"), "purged");
    check(!new File(dir, "rec1.audio").exists(), "clip erased");
    check(store.describe("rec1").getString("transcript").isEmpty(), "transcript cleared");
    check(store.purge("rec1", "note1", B, stop).getString("status").equals("purged"), "replay");
    check(
        store.remove("rec1", "note1", B, stop).getString("status").equals("purged"),
        "a purged operation answers its receipt");
    rejects(() -> store.restore("rec1", "note1", B, stop), "an erased recording cannot be restored");
    rejects(
        () -> store.retain(source, "rec1", "note1", 10, "t"), "a deleted id is retired for good");
    check(
        store.deletionStatus("rec1", "note1", B).getString("status").equals("purged"),
        "status reads the receipt");

    // Restore window: trash older than 30 days is no longer restorable.
    store.retain(source, "rec3", "note3", 10, "t");
    store.remove("rec3", "note3", A, null);
    now.addAndGet(RecordingStore.RESTORE_WINDOW_MS + 1);
    rejects(() -> store.restore("rec3", "note3", A, null), "restore window elapsed");
    now.addAndGet(-(RecordingStore.RESTORE_WINDOW_MS + 1));

    // Receipt history is bounded and never evicted.
    store.retain(source, "rec4", "note4", 10, "t");
    for (int i = 0; i < RecordingStore.MAX_OPERATIONS; i++) {
      String op = String.format("00000000-0000-4000-8000-%012x", 0x100 + i);
      store.remove("rec4", "note4", op, null);
      store.restore("rec4", "note4", op, null);
    }
    rejects(
        () -> store.remove("rec4", "note4", "00000000-0000-4000-8000-0000000fffff", null),
        "operation history full");

    // Background purge of trash: only the owning removed operation; never throws.
    store.retain(source, "rec5", "note5", 10, "t");
    check(!store.purgeTrashed("rec5", "note5", A), "not in trash");
    store.remove("rec5", "note5", A, null);
    check(!store.purgeTrashed("rec5", "other", A), "owner fence");
    check(!store.purgeTrashed("rec5", "note5", B), "another operation");
    check(!store.purgeTrashed("rec5", "note5", "bad"), "malformed operation");
    check(!store.purgeTrashed("missing", "note5", A), "unknown recording");
    check(store.purgeTrashed("rec5", "note5", A), "erased");
    check(store.purgeTrashed("rec5", "note5", A), "idempotent");
    check(!new File(dir, "rec5.audio").exists(), "clip gone");

    // Finishing a committed permanent deletion: moves and erases a never-moved recording.
    store.retain(source, "rec6", "note6", 10, "t");
    check(store.finishPermanent("rec6", "note6", A, now.get()), "never moved: moved then erased");
    JSONObject finished = store.describe("rec6");
    check(finished.getJSONObject("deletionOperations").getString(A).equals("purged"), "receipt");
    check(finished.getString("activeDeletionOperation").equals(A), "owned by the operation");
    check(store.finishPermanent("rec6", "note6", A, now.get()), "idempotent");
    store.retain(source, "rec7", "note7", 10, "t");
    store.remove("rec7", "note7", B, null);
    check(!store.finishPermanent("rec7", "note7", A, now.get()), "another deletion holds it");
    check(new File(dir, "rec7.audio").isFile(), "and its clip stays");
    store.restore("rec7", "note7", B, null);
    check(!store.finishPermanent("rec7", "note7", B, now.get()), "a restored receipt is final");
    check(!store.finishPermanent("rec7", "other", A, now.get()), "owner fence");

    // Legacy plaintext metadata migrates into the slot; a disagreeing pair is refused.
    File legacyClip = new File(dir, "old1.audio");
    Files.write(legacyClip.toPath(), new byte[8]);
    JSONObject legacy =
        new JSONObject()
            .put("audioId", "old1")
            .put("noteId", "noteOld")
            .put("durationMs", 5)
            .put("transcript", "Old");
    Files.write(
        new File(dir, "old1.json").toPath(), legacy.toString().getBytes(StandardCharsets.UTF_8));
    check(store.describe("old1").getString("transcript").equals("Old"), "legacy record read");
    check(
        slots.values.get("note-audio-metadata:v1:old1").equals(legacy.toString()),
        "legacy record migrated into the slot");
    check(
        new String(Files.readAllBytes(new File(dir, "old1.json").toPath()), StandardCharsets.UTF_8)
            .equals("{\"encrypted\":1}"),
        "plaintext replaced only after read-back");
    Files.write(
        new File(dir, "old2.json").toPath(),
        "{\"audioId\":\"old2\",\"noteId\":\"n\",\"transcript\":\"a\"}".getBytes(StandardCharsets.UTF_8));
    slots.values.put("note-audio-metadata:v1:old2", "{\"audioId\":\"old2\",\"noteId\":\"n\",\"transcript\":\"b\"}");
    rejects(() -> store.describe("old2"), "disagreeing copies are kept and refused");
    check(new File(dir, "old2.json").length() > 20, "plaintext original retained");
    // A legacy backup file left by an older platform is restored before reading.
    Files.write(
        new File(dir, "old3.json.bak").toPath(),
        "{\"audioId\":\"old3\",\"noteId\":\"n3\",\"transcript\":\"bak\"}".getBytes(StandardCharsets.UTF_8));
    check(store.describe("old3").getString("transcript").equals("bak"), "legacy backup read");

    // Legacy trash without receipts: restorable by any operation within the window.
    File legacyTrash = new File(dir, "old4.audio");
    Files.write(legacyTrash.toPath(), new byte[8]);
    slots.values.put(
        "note-audio-metadata:v1:old4",
        new JSONObject()
            .put("audioId", "old4")
            .put("noteId", "n4")
            .put("transcript", "x")
            .put("deletedAt", now.get() - DAY)
            .toString());
    check(store.restore("old4", "n4", A, null).getString("status").equals("restored"), "legacy restore");

    // Startup pass: legacy trash older than the window is erased; receipts are kept.
    File expired = new File(dir, "old5.audio");
    Files.write(expired.toPath(), new byte[8]);
    slots.values.put(
        "note-audio-metadata:v1:old5",
        new JSONObject()
            .put("audioId", "old5")
            .put("noteId", "n5")
            .put("transcript", "gone")
            .put("deletedAt", now.get() - RecordingStore.RESTORE_WINDOW_MS - DAY)
            .toString());
    Files.write(new File(dir, "old5.json").toPath(), "{\"encrypted\":1}".getBytes(StandardCharsets.UTF_8));
    File receipted = new File(dir, "old6.audio");
    Files.write(receipted.toPath(), new byte[8]);
    slots.values.put(
        "note-audio-metadata:v1:old6",
        new JSONObject()
            .put("audioId", "old6")
            .put("noteId", "n6")
            .put("transcript", "kept receipts")
            .put("deletedAt", now.get() - RecordingStore.RESTORE_WINDOW_MS - DAY)
            .put("activeDeletionOperation", A)
            .put("deletionOperations", new JSONObject().put(A, "removed"))
            .toString());
    Files.write(new File(dir, "old6.json").toPath(), "{\"encrypted\":1}".getBytes(StandardCharsets.UTF_8));
    Files.write(new File(dir, "bad name.json").toPath(), "{}".getBytes(StandardCharsets.UTF_8));
    int failures = store.migrateLegacy(() -> false);
    check(failures == 2, "the disagreeing pair and the malformed name are kept for recovery");
    check(!expired.exists(), "expired legacy clip erased");
    check(!slots.values.containsKey("note-audio-metadata:v1:old5"), "receipt-less metadata removed");
    check(!new File(dir, "old5.json").exists(), "and its marker");
    check(!receipted.exists(), "expired clip with receipts erased");
    JSONObject kept = new JSONObject(slots.values.get("note-audio-metadata:v1:old6"));
    check(kept.getString("transcript").isEmpty(), "transcript cleared");
    check(kept.getJSONObject("deletionOperations").getString(A).equals("removed"), "receipts kept");
    check(store.migrateLegacy(() -> true) == 0, "a stopped pass returns at once");
  }
}
