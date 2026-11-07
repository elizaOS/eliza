package ai.elizaos.app;

import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/** Production durable inbox admission at the actual service reconnect boundary. */
public final class NativeNotificationReconnectReplayTest {
    private static int checks;
    private static final String OWNER = "a".repeat(64), EPOCH = "10000000-0000-0000-0000-000000000001";
    private static void check(boolean value, String why) { if (!value) throw new AssertionError(why); checks++; }
    private static JSONObject item(int sequence) throws Exception {
        return new JSONObject().put("id", String.format("20000000-0000-0000-0000-%012d", sequence))
            .put("title", "Reconnect test").put("body", "").put("priority", "normal").put("category", "reminder")
            .put("createdAt", 1).put("nativeEpoch", EPOCH).put("nativeSequence", sequence);
    }
    private static JSONObject page(int through, JSONArray rows) throws Exception {
        return new JSONObject().put("serviceStatus", "ready").put("nativeEpoch", EPOCH)
            .put("throughSequence", through).put("nextSequence", through).put("complete", true).put("notifications", rows);
    }
    private static NativeNotificationInbox inbox(Path path, AtomicInteger posts) throws Exception {
        return new NativeNotificationInbox(path, OWNER, n -> { posts.incrementAndGet(); return true; },
            dir -> { try (var file = FileChannel.open(dir, StandardOpenOption.READ)) { file.force(true); } });
    }
    public static void main(String[] args) throws Exception {
        String service = Files.readString(Path.of(args[0]).resolve("packages/app/platforms/android/app/src/main/java/ai/elizaos/app/NativeNotificationConnectionService.java"));
        int connect = service.indexOf("private void connect()");
        check(connect >= 0 && service.indexOf("inbox.beginBaseline()", connect) < service.indexOf("http.newWebSocket", connect), "Actual service must open reconciliation before admitting replay");
        check(service.contains("shared.acceptLive(notification)"), "Actual foreground path must share this production admission");
        for (boolean initialized : new boolean[]{false, true}) {
            Path dir = Files.createTempDirectory("native-reconnect-replay-").toRealPath();
            AtomicInteger posts = new AtomicInteger(); var live = inbox(dir, posts);
            if (initialized) live.acceptPage(page(0, new JSONArray()), live.pageCursor());
            live.beginBaseline();
            var foreground = inbox(dir, posts);
            live.acceptLive(item(1));
            foreground.acceptLive(item(2));
            live.acceptLive(item(3));
            check(posts.get() == 0, "Replay/foreground arrivals must await authoritative read/delete presence (initialized=" + initialized + ")");
            check(live.status().getInt("pendingBuffered") == 3, "Every original arrival retained durably");
            check(live.acceptPage(page(3, new JSONArray().put(item(1)).put(item(2).put("readAt", 1))), live.pageCursor()), "Authoritative completed page closes read/deleted range");
            check(posts.get() == 1, "Only current unread notification posts once");
            for (int i = 1; i <= 3; i++) foreground.acceptLive(item(i));
            check(posts.get() == 1, "Old replay is covered by the closed range");
        }
        // An above-fence arrival cannot be treated as proven present merely
        // because the earlier fixed crawl has exhausted its own range.
        Path dir = Files.createTempDirectory("native-above-fence-replay-").toRealPath();
        AtomicInteger posts = new AtomicInteger(); var box = inbox(dir, posts);
        box.acceptPage(page(0, new JSONArray()), box.pageCursor()); box.beginBaseline();
        box.acceptLive(item(4)); box.acceptLive(item(5)); box.acceptLive(item(6));
        check(!box.acceptPage(page(3, new JSONArray()), box.pageCursor()), "Above-fence presence requires the next authoritative crawl");
        check(posts.get() == 0 && box.status().getInt("pendingBuffered") == 3, "Above-fence arrivals remain retained, never assumed current");
        check(box.acceptPage(page(6, new JSONArray().put(item(4)).put(item(5).put("readAt", 1))), box.pageCursor()), "Next fence resolves unread/read/deleted arrivals");
        check(posts.get() == 1, "Only authoritative above-fence unread arrival posts");
        System.out.println("Native reconnect replay passed: " + checks + " checks");
    }
}
