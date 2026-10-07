package ai.elizaos.app;

import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/** Production file journal, baseline races and real process death; no Android or network effects. */
public final class NativeNotificationInboxTest {
    private static int checks;
    private static final String OWNER = "a".repeat(64), OTHER = "b".repeat(64);
    private static final String A = "10000000-0000-0000-0000-000000000001", B = "10000000-0000-0000-0000-000000000002", C = "10000000-0000-0000-0000-000000000003", D = "10000000-0000-0000-0000-000000000004";
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value) { if (!value) throw new AssertionError(); checks++; }
    private static void rejects(Checked action) throws Exception { try { action.run(); } catch (Exception expected) { checks++; return; } throw new AssertionError("Invalid inbox operation accepted"); }
    private static void sync(Path directory) throws java.io.IOException { try (var channel = FileChannel.open(directory, StandardOpenOption.READ)) { channel.force(true); } }
    private static JSONObject record(String id) throws Exception { return new JSONObject().put("id", id).put("title", "Synthetic title").put("category", "reminder").put("priority", "high").put("source", "fixture").put("createdAt", System.currentTimeMillis()); }
    private static NativeNotificationInbox inbox(Path root, String owner, AtomicInteger effects) throws Exception { return new NativeNotificationInbox(root, owner, item -> { effects.incrementAndGet(); return true; }, NativeNotificationInboxTest::sync); }
    public static void main(String[] args) throws Exception {
        if (args.length > 0) {
            var box = new NativeNotificationInbox(Path.of(args[0]), OWNER, item -> { Runtime.getRuntime().halt(19); return false; }, NativeNotificationInboxTest::sync);
            box.beginBaseline(); box.completeBaseline(new JSONArray()); box.acceptLive(record(A)); throw new AssertionError();
        }
        Path root = Files.createTempDirectory("native-notification-inbox-").toRealPath();
        AtomicInteger effects = new AtomicInteger();
        var box = inbox(root, OWNER, effects);
        box.beginBaseline(); box.acceptLive(record(B));
        check(box.status().getInt("pendingBuffered") == 1);
        box.completeBaseline(new JSONArray().put(record(A)).put(record(B)));
        check(effects.get() == 1); check(box.status().getInt("acceptedCount") == 1);
        box.acceptLive(record(A)); box.acceptLive(record(B)); check(effects.get() == 1);
        // Reconnect catches up unseen persisted notifications, never the initial historical snapshot.
        box.beginBaseline(); box.completeBaseline(new JSONArray().put(record(A)).put(record(B)).put(record(C)));
        check(effects.get() == 2); check(box.status().getInt("seenCount") == 3);
        var restored = inbox(root, OWNER, effects); restored.acceptLive(record(C)); check(effects.get() == 2);
        var other = inbox(root, OTHER, effects); other.beginBaseline(); other.completeBaseline(new JSONArray()); other.acceptLive(record(C)); check(effects.get() == 3);
        restored.acceptLive(record(D).put("readAt", 1)); check(effects.get() == 3);
        restored.acceptLive(record("10000000-0000-0000-0000-000000000005").put("expiresAt", 1)); check(effects.get() == 3);
        restored.acceptLive(record("10000000-0000-0000-0000-000000000006").put("priority", "low")); check(effects.get() == 3);
        rejects(() -> restored.acceptLive(record(A).put("createdAt", "123")));
        rejects(() -> restored.acceptLive(record(A).put("createdAt", 1.5)));
        rejects(() -> restored.acceptLive(record("not-a-uuid")));
        rejects(() -> restored.acceptLive(record(A).put("priority", "invented")));
        rejects(() -> restored.completeBaseline(new JSONArray().put(record(A)).put(record(A))));
        Path failedRoot = Files.createTempDirectory("native-notification-failed-").toRealPath();
        var failed = new NativeNotificationInbox(failedRoot, OWNER, item -> { effects.incrementAndGet(); throw new java.io.IOException("Ambiguous post"); }, NativeNotificationInboxTest::sync);
        failed.completeBaseline(new JSONArray()); rejects(() -> failed.acceptLive(record(A))); int once = effects.get();
        inbox(failedRoot, OWNER, effects).acceptLive(record(A)); check(effects.get() == once); check(failed.status().getInt("unknownCount") == 1);
        Path deadRoot = Files.createTempDirectory("native-notification-crash-").toRealPath();
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp", System.getProperty("java.class.path"), NativeNotificationInboxTest.class.getName(), deadRoot.toString()).inheritIO().start();
        check(process.waitFor() == 19);
        var afterDeath = inbox(deadRoot, OWNER, effects); afterDeath.acceptLive(record(A)); check(effects.get() == once); check(afterDeath.status().getInt("unknownCount") == 1);
        // Original live contents survive duplicates and baseline overlap without being replaced by an update.
        Path raceRoot = Files.createTempDirectory("native-notification-race-").toRealPath(); AtomicInteger raced = new AtomicInteger();
        var race = new NativeNotificationInbox(raceRoot, OWNER, item -> { check(item.getString("title").equals("Original")); raced.incrementAndGet(); return true; }, NativeNotificationInboxTest::sync);
        race.beginBaseline(); race.acceptLive(record(A).put("title", "Original")); race.acceptLive(record(A).put("title", "Update")); race.completeBaseline(new JSONArray().put(record(A).put("title", "Snapshot"))); check(raced.get() == 1);
        Path concurrentRoot = Files.createTempDirectory("native-notification-concurrent-").toRealPath(); AtomicInteger concurrentEffects = new AtomicInteger();
        var one = inbox(concurrentRoot, OWNER, concurrentEffects); one.completeBaseline(new JSONArray());
        var two = inbox(concurrentRoot, OWNER, concurrentEffects);
        var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            var first = pool.submit(() -> { try { one.acceptLive(record(A)); } catch (Exception error) { throw new RuntimeException(error); } });
            var second = pool.submit(() -> { try { two.acceptLive(record(A)); } catch (Exception error) { throw new RuntimeException(error); } });
            first.get(); second.get(); check(concurrentEffects.get() == 1);
        } finally { pool.shutdownNow(); }
        Path boundedRoot = Files.createTempDirectory("native-notification-bounded-").toRealPath();
        var bounded = inbox(boundedRoot, OWNER, effects); bounded.beginBaseline();
        for (int i = 0; i < 128; i++) bounded.acceptLive(record(String.format("20000000-0000-0000-0000-%012d", i)));
        rejects(() -> bounded.acceptLive(record("20000000-0000-0000-0000-000000000999")));
        check(bounded.status().getInt("pendingBuffered") == 128);
        Path journal = boundedRoot.resolve("native-notification-inbox").resolve(OWNER + ".json");
        JSONObject corrupted = new JSONObject(Files.readString(journal)).put("owner", OTHER);
        Files.writeString(journal, corrupted.toString());
        rejects(() -> bounded.status());
        // Foreground and the persistent connection share one owner journal. An
        // initial offline arrival is retained, never claimed presented/history.
        Path foregroundRoot = Files.createTempDirectory("native-notification-foreground-").toRealPath(); AtomicInteger foregroundEffects = new AtomicInteger();
        var foreground = inbox(foregroundRoot, OWNER, foregroundEffects);
        JSONObject offline = foreground.acceptLive(record(A));
        check(offline.getString("state").equals("buffered")); check(offline.getBoolean("retained")); check(!offline.getBoolean("presented"));
        check(!foreground.status().getBoolean("initialized")); check(foregroundEffects.get() == 0);
        var connection = inbox(foregroundRoot, OWNER, foregroundEffects); connection.beginBaseline();
        connection.completeBaseline(new JSONArray().put(record(A)).put(record(B)));
        check(foregroundEffects.get() == 1); check(connection.status().getBoolean("initialized"));
        JSONObject duplicate = foreground.acceptLive(record(A));
        check(duplicate.getBoolean("duplicate")); check(!duplicate.getBoolean("presented")); check(foregroundEffects.get() == 1);
        // During an initialized reconnect, a foreground record can present now;
        // its subsequent full server snapshot must not present it again.
        connection.beginBaseline();
        JSONObject posted = foreground.acceptLive(record(C));
        check(posted.getString("state").equals("accepted")); check(posted.getBoolean("presented"));
        check(foregroundEffects.get() == 2); check(!connection.status().getBoolean("baselineReady"));
        connection.completeBaseline(new JSONArray().put(record(A)).put(record(B)).put(record(C)));
        check(foregroundEffects.get() == 2);
        Path readRaceRoot = Files.createTempDirectory("native-notification-read-race-").toRealPath(); AtomicInteger readEffects = new AtomicInteger();
        var readRace = inbox(readRaceRoot, OWNER, readEffects);
        readRace.acceptLive(record(A));
        readRace.completeBaseline(new JSONArray().put(record(A).put("readAt", 1)));
        check(readEffects.get() == 0); check(readRace.status().getInt("acceptedCount") == 0);
        // All supported explicit categories pass the same exact record contract.
        for (String category : new String[]{"reminder", "task", "workflow", "agent", "approval", "message", "health", "system", "general"}) check(NativeNotificationInbox.checked(record(A).put("category", category)).getString("category").equals(category));
        System.out.println("Native notification inbox passed: " + checks + " checks; no Android/network effects");
    }
}
