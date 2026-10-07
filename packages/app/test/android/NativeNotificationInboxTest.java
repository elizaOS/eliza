package ai.elizaos.app;

import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/** Production file journal, paging races and real process death; no Android/network effects. */
public final class NativeNotificationInboxTest {
    private static int checks;
    private static final String OWNER = "a".repeat(64), OTHER = "b".repeat(64);
    private static final String EPOCH = "10000000-0000-0000-0000-000000000001";
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { if (!value) throw new AssertionError("Check " + checks); checks++; }
    private static void rejects(Checked action) throws Exception { try { action.run(); } catch (Exception expected) { checks++; return; } throw new AssertionError("Invalid operation accepted"); }
    private static void sync(Path directory) throws java.io.IOException { try (var channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); } }
    private static String id(long sequence) { return String.format("20000000-0000-0000-0000-%012d", sequence); }
    private static JSONObject record(long sequence) throws Exception {
        return new JSONObject().put("id", id(sequence)).put("title", "Synthetic title").put("body", "")
            .put("category", "reminder").put("priority", "high").put("createdAt", 1)
            .put("nativeEpoch", EPOCH).put("nativeSequence", sequence);
    }
    private static JSONObject page(long through, long next, boolean complete, JSONArray records) throws Exception {
        return new JSONObject().put("serviceStatus", "ready").put("nativeEpoch", EPOCH)
            .put("throughSequence", through).put("nextSequence", next).put("complete", complete).put("notifications", records);
    }
    private static void finish(NativeNotificationInbox box, long through, JSONArray rows) throws Exception {
        check(box.acceptPage(page(through, through, true, rows), box.pageCursor()));
    }
    private static Path root() throws Exception { return Files.createTempDirectory("native-notification-journal-").toRealPath(); }
    private static NativeNotificationInbox inbox(Path root, String owner, AtomicInteger effects) throws Exception {
        return new NativeNotificationInbox(root, owner, item -> { effects.incrementAndGet(); return true; }, NativeNotificationInboxTest::sync);
    }
    private static Path journal(Path root) { return root.resolve("native-notification-inbox").resolve(OWNER + ".json"); }

    public static void main(String[] args) throws Exception {
        if (args.length > 1 && "buffer-page".equals(args[1])) {
            var bufferedCrash = inbox(Path.of(args[0]), OWNER, new AtomicInteger());
            bufferedCrash.acceptLive(record(1).put("title", "Original buffered arrival"));
            bufferedCrash.acceptLive(record(2));
            bufferedCrash.acceptLive(record(4));
            bufferedCrash.acceptLive(record(5).put("nativeEpoch", "40000000-0000-0000-0000-000000000001"));
            bufferedCrash.acceptPage(page(3, 1, false, new JSONArray().put(record(1).put("title", "Snapshot title"))), bufferedCrash.pageCursor());
            Runtime.getRuntime().halt(23); throw new AssertionError();
        }
        if (args.length > 0) {
            var box = new NativeNotificationInbox(Path.of(args[0]), OWNER, item -> { Runtime.getRuntime().halt(19); return false; }, NativeNotificationInboxTest::sync);
            finish(box, 0, new JSONArray());
            box.acceptPage(page(2, 2, true, new JSONArray().put(record(1)).put(record(2))), box.pageCursor());
            throw new AssertionError();
        }
        AtomicInteger effects = new AtomicInteger(); Path root = root(); var box = inbox(root, OWNER, effects);
        box.beginBaseline(); box.acceptLive(record(2));
        check(box.status().getInt("pendingBuffered") == 1);
        check(!box.acceptPage(page(4, 2, false, new JSONArray().put(record(1)).put(record(2).put("readAt", 1))), box.pageCursor()));
        check(!box.status().getBoolean("initialized")); check(effects.get() == 0);
        // Process restart resumes the fixed fence and keeps the original live arrival.
        var restored = inbox(root, OWNER, effects);
        check(restored.pageCursor().getLong("afterSequence") == 2); check(restored.pageCursor().getLong("throughSequence") == 4);
        restored.acceptLive(record(1)); check(restored.status().getInt("pendingBuffered") == 1);
        restored.acceptLive(record(5));
        check(!restored.acceptPage(page(4, 4, true, new JSONArray().put(record(3))), restored.pageCursor()));
        check(effects.get() == 0); // Above-fence frame alone is not current presence.
        finish(restored, 5, new JSONArray().put(record(5)));
        check(restored.status().getBoolean("initialized")); check(effects.get() == 1);
        check(restored.status().getLong("closedThroughSequence") == 5); check(restored.status().getInt("seenCount") == 0);
        restored.acceptLive(record(1)); restored.acceptLive(record(5)); check(effects.get() == 1);
        // Above-fence live receipts survive compaction; missed records page in sequence order.
        restored.beginBaseline(); restored.acceptLive(record(8));
        check(!restored.acceptPage(page(9, 7, false, new JSONArray().put(record(6)).put(record(7))), restored.pageCursor()));
        check(effects.get() == 3); check(restored.status().getInt("seenCount") == 0);
        finish(restored, 9, new JSONArray().put(record(8))); check(effects.get() == 4);
        check(restored.status().getInt("seenCount") == 0);
        restored.acceptLive(record(7)); check(effects.get() == 4);
        var other = inbox(root, OTHER, effects); finish(other, 0, new JSONArray()); other.acceptLive(record(7)); check(effects.get() == 5);

        // A deleted pre-activation arrival is not authorized by an empty completed range.
        Path deletedRoot = root(); AtomicInteger deletedEffects = new AtomicInteger(); var deleted = inbox(deletedRoot, OWNER, deletedEffects);
        deleted.acceptLive(record(1)); finish(deleted, 1, new JSONArray());
        check(deletedEffects.get() == 0); check(deleted.status().getInt("pendingBuffered") == 0);
        deleted.acceptLive(record(1)); check(deletedEffects.get() == 0);
        // Matching evidence spans pages and survives actual process death; deleted in-fence rows do not present.
        Path bufferCrashRoot = root();
        Process bufferCrash = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp", System.getProperty("java.class.path"), NativeNotificationInboxTest.class.getName(), bufferCrashRoot.toString(), "buffer-page").inheritIO().start();
        check(bufferCrash.waitFor() == 23);
        AtomicInteger preservedEffects = new AtomicInteger();
        var preserved = new NativeNotificationInbox(bufferCrashRoot, OWNER, item -> {
            if (item.getLong("nativeSequence") == 1) check(item.getString("title").equals("Original buffered arrival"));
            preservedEffects.incrementAndGet(); return true;
        }, NativeNotificationInboxTest::sync);
        check(preserved.pageCursor().getLong("afterSequence") == 1);
        check(!preserved.acceptPage(page(3, 3, true, new JSONArray()), preserved.pageCursor()));
        check(preservedEffects.get() == 1); // seq4 waits for authoritative next range.
        finish(preserved, 4, new JSONArray().put(record(4)));
        check(preservedEffects.get() == 2); check(preserved.status().getInt("pendingBuffered") == 1);
        check(preserved.status().getInt("seenCount") == 0); check(preserved.status().getLong("closedThroughSequence") == 4);
        preserved.acceptLive(record(2)); check(preservedEffects.get() == 2);
        // A matching UUID from another epoch does not rewrite the retained arrival.
        finish(preserved, 5, new JSONArray().put(record(5)));
        check(preserved.status().getInt("pendingBuffered") == 1);
        check(new JSONObject(Files.readString(journal(bufferCrashRoot))).getJSONObject("buffered").getJSONObject(id(5))
            .getString("nativeEpoch").equals("40000000-0000-0000-0000-000000000001"));
        // Starting another crawl cannot reuse presence evidence from a retired traversal.
        Path resetRoot = root(); AtomicInteger resetEffects = new AtomicInteger(); var reset = inbox(resetRoot, OWNER, resetEffects);
        reset.acceptLive(record(1)); check(!reset.acceptPage(page(2, 1, false, new JSONArray().put(record(1))), reset.pageCursor()));
        reset.restartEpoch(); finish(reset, 2, new JSONArray()); check(resetEffects.get() == 0);
        // Legacy arrivals without authoritative coordinates remain unresolved when absent.
        Path missingLegacyRoot = root(); var missingLegacy = inbox(missingLegacyRoot, OWNER, resetEffects); missingLegacy.status();
        JSONObject missingArrival = record(1); missingArrival.remove("nativeEpoch"); missingArrival.remove("nativeSequence");
        Files.writeString(journal(missingLegacyRoot), new JSONObject().put("version", 1).put("owner", OWNER).put("initialized", false)
            .put("baselineReady", false).put("seen", new JSONObject()).put("buffered", new JSONObject().put(id(1), missingArrival)).toString());
        finish(missingLegacy, 1, new JSONArray()); check(resetEffects.get() == 0); check(missingLegacy.status().getInt("pendingBuffered") == 1);
        // Partial/ambiguous effect leaves the range open and cannot replay across retry or restart.
        Path failedRoot = root(); AtomicInteger attempted = new AtomicInteger();
        var failed = new NativeNotificationInbox(failedRoot, OWNER, item -> { attempted.incrementAndGet(); throw new java.io.IOException("Ambiguous post"); }, NativeNotificationInboxTest::sync);
        finish(failed, 0, new JSONArray());
        rejects(() -> failed.acceptPage(page(2, 2, true, new JSONArray().put(record(1)).put(record(2))), failed.pageCursor()));
        check(failed.status().getLong("closedThroughSequence") == 0); check(attempted.get() == 1);
        var recovered = inbox(failedRoot, OWNER, attempted); finish(recovered, 2, new JSONArray().put(record(1)).put(record(2)));
        check(attempted.get() == 2); check(recovered.status().getInt("unknownCount") == 1);
        recovered.acceptLive(record(1)); check(attempted.get() == 2);

        Path deadRoot = root();
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp", System.getProperty("java.class.path"), NativeNotificationInboxTest.class.getName(), deadRoot.toString()).inheritIO().start();
        check(process.waitFor() == 19);
        var afterDeath = inbox(deadRoot, OWNER, attempted); check(afterDeath.status().getLong("closedThroughSequence") == 0);
        finish(afterDeath, 2, new JSONArray().put(record(1)).put(record(2)));
        check(attempted.get() == 3); check(afterDeath.status().getInt("unknownCount") == 1);

        // A stale/malformed page never advances over out-of-order candidates or invented deleted gaps.
        long closed = restored.status().getLong("closedThroughSequence");
        rejects(() -> restored.acceptPage(page(12, 11, false, new JSONArray().put(record(11)).put(record(10))), restored.pageCursor()));
        rejects(() -> restored.acceptPage(page(12, 12, false, new JSONArray().put(record(10))), restored.pageCursor()));
        rejects(() -> restored.acceptPage(page(12, 12, true, new JSONArray().put(record(10)).put(record(10))), restored.pageCursor()));
        rejects(() -> restored.acceptPage(page(12, 11, true, new JSONArray().put(record(10))), restored.pageCursor()));
        check(restored.status().getLong("closedThroughSequence") == closed);
        JSONObject stale = restored.pageCursor();
        check(!restored.acceptPage(page(12, 10, false, new JSONArray().put(record(10))), stale));
        rejects(() -> restored.acceptPage(page(12, 12, true, new JSONArray().put(record(11))), stale));
        rejects(() -> restored.acceptPage(page(13, 13, true, new JSONArray().put(record(11))), restored.pageCursor()));
        finish(restored, 12, new JSONArray()); check(restored.status().getLong("closedThroughSequence") == 12);
        restored.acceptLive(record(11)); check(effects.get() == 6);

        // Exactly 128 buffered arrivals remain durable through a crash/reopen.
        Path boundedRoot = root(); var bounded = inbox(boundedRoot, OWNER, effects);
        for (int i = 1; i <= 128; i++) bounded.acceptLive(record(i));
        rejects(() -> bounded.acceptLive(record(129))); check(inbox(boundedRoot, OWNER, effects).status().getInt("pendingBuffered") == 128);
        JSONArray first = new JSONArray(); for (int i = 1; i <= 128; i++) first.put(record(i).put("readAt", 1));
        finish(bounded, 128, first); check(bounded.status().getInt("pendingBuffered") == 0);

        // Old terminal10k receipts and ambiguous UUIDs remain pinned outside the new capacity.
        Path migratedRoot = root(); var migrated = inbox(migratedRoot, OWNER, effects); migrated.status();
        JSONObject legacy = new JSONObject(); for (int i = 1; i <= 10000; i++) legacy.put(id(i), i == 1 ? "unknown" : i == 2 ? "dispatched" : "accepted");
        Files.writeString(journal(migratedRoot), new JSONObject().put("version", 1).put("owner", OWNER).put("initialized", true)
            .put("baselineReady", true).put("seen", legacy).put("buffered", new JSONObject()).toString());
        check(migrated.status().getInt("legacySeenCount") == 10000); check(migrated.status().getInt("seenCount") == 0);
        int beforeMigration = effects.get(); migrated.acceptLive(record(1)); migrated.acceptLive(record(2));
        finish(migrated, 10001, new JSONArray().put(record(10000)).put(record(10001)));
        check(effects.get() == beforeMigration + 1); check(migrated.status().getInt("legacySeenCount") == 10000);
        check(migrated.status().getInt("unknownCount") == 2);

        // More than10k historical rows converge within128-record pages and bounded normal receipts.
        Path largeRoot = root(); var large = inbox(largeRoot, OWNER, effects); int beforeHistory = effects.get();
        for (int start = 1; start <= 10100; start += 128) {
            JSONArray rows = new JSONArray(); int last = Math.min(start + 127, 10100);
            for (int i = start; i <= last; i++) rows.put(record(i));
            boolean done = large.acceptPage(page(10100, last, last == 10100, rows), large.pageCursor());
            check(done == (last == 10100)); check(large.status().getInt("seenCount") == 0);
        }
        check(effects.get() == beforeHistory); check(large.status().getLong("closedThroughSequence") == 10100);
        // Subsequent ignored catch-up also converges without accumulating terminal receipts.
        JSONArray ignored = new JSONArray().put(record(10101).put("readAt", 1)).put(record(10102).put("expiresAt", 1)).put(record(10103).put("priority", "low"));
        finish(large, 10103, ignored); check(effects.get() == beforeHistory); check(large.status().getInt("seenCount") == 0);

        // An initialized catch-up larger than128 presents every missed row once.
        Path missedRoot = root(); AtomicInteger missedEffects = new AtomicInteger(); var missed = inbox(missedRoot, OWNER, missedEffects);
        finish(missed, 0, new JSONArray()); JSONArray missedFirst = new JSONArray();
        for (int i = 1; i <= 128; i++) missedFirst.put(record(i));
        check(!missed.acceptPage(page(129, 128, false, missedFirst), missed.pageCursor()));
        var missedRestart = inbox(missedRoot, OWNER, missedEffects); finish(missedRestart, 129, new JSONArray().put(record(129)));
        check(missedEffects.get() == 129); missedRestart.acceptLive(record(128)); check(missedEffects.get() == 129);
        // A server epoch replacement starts a fresh historical baseline and protects old ambiguous IDs.
        recovered.restartEpoch(); check(recovered.pageCursor().getLong("afterSequence") == 0);
        String replacementEpoch = "30000000-0000-0000-0000-000000000001";
        JSONObject replacement = page(1, 1, true, new JSONArray().put(record(1).put("nativeEpoch", replacementEpoch))).put("nativeEpoch", replacementEpoch);
        int beforeEpoch = attempted.get(); check(recovered.acceptPage(replacement, recovered.pageCursor()));
        check(attempted.get() == beforeEpoch); check(recovered.status().getInt("unknownCount") == 1);
        check(recovered.status().getString("nativeEpoch").equals(replacementEpoch));
        recovered.acceptLive(record(2).put("nativeEpoch", replacementEpoch)); check(attempted.get() == beforeEpoch + 1);
        // A migrated v1 buffer gets coordinates from its matching authoritative row before presentation.
        Path oldBufferRoot = root(); var oldBuffer = inbox(oldBufferRoot, OWNER, effects); oldBuffer.status();
        JSONObject oldArrival = record(1).put("title", "Legacy original"); oldArrival.remove("nativeEpoch"); oldArrival.remove("nativeSequence");
        Files.writeString(journal(oldBufferRoot), new JSONObject().put("version", 1).put("owner", OWNER).put("initialized", false)
            .put("baselineReady", false).put("seen", new JSONObject()).put("buffered", new JSONObject().put(id(1), oldArrival)).toString());
        int beforeOldBuffer = effects.get(); finish(oldBuffer, 1, new JSONArray().put(record(1))); check(effects.get() == beforeOldBuffer + 1);
        check(oldBuffer.status().getInt("pendingBuffered") == 0);
        // Concurrent foreground/connection effects share a real file lock.
        Path concurrentRoot = root(); AtomicInteger concurrentEffects = new AtomicInteger();
        var one = inbox(concurrentRoot, OWNER, concurrentEffects); finish(one, 0, new JSONArray());
        var two = inbox(concurrentRoot, OWNER, concurrentEffects); var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var a = pool.submit(() -> { try { one.acceptLive(record(1)); } catch (Exception error) { throw new RuntimeException(error); } });
            var b = pool.submit(() -> { try { two.acceptLive(record(1)); } catch (Exception error) { throw new RuntimeException(error); } });
            a.get(); b.get(); check(concurrentEffects.get() == 1);
        } finally { pool.shutdownNow(); }
        // Authority is checked inside the journal lock and directly before the OS callback.
        AtomicInteger guards = new AtomicInteger(); var guarded = new NativeNotificationInbox(concurrentRoot, OWNER, item -> { throw new AssertionError(); }, NativeNotificationInboxTest::sync,
            () -> { guards.incrementAndGet(); throw new SecurityException("Revoked"); });
        rejects(() -> guarded.acceptLive(record(2))); check(guards.get() == 1); check(one.status().getInt("seenCount") == 1);
        JSONObject corrupted = new JSONObject(Files.readString(journal(concurrentRoot))).put("owner", OTHER);
        Files.writeString(journal(concurrentRoot), corrupted.toString()); rejects(() -> one.status());
        System.out.println("Native notification journal/paging passed: " + checks + " checks; no Android/network effects");
    }
}
