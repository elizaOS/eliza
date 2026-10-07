package ai.elizaos.app;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native per-owner inbox reconciliation. A committed dispatch marker precedes every OS effect.
 * The initial full snapshot is history, not new alerts. Later snapshots recover missed new records.
 * Unknown posts never replay after process death or a lost acknowledgement. */
final class NativeNotificationInbox {
    interface Projector { boolean post(JSONObject notification) throws Exception; }
    interface DirectorySync { void sync(Path directory) throws IOException; }
    private static final int MAX_SEEN = 10000, MAX_BUFFERED = 128, MAX_BYTES = 4 * 1024 * 1024;
    private static final ConcurrentHashMap<Path, Object> LOCKS = new ConcurrentHashMap<>();
    private final Path directory, file, lock;
    private final String owner;
    private final Projector projector;
    private final DirectorySync sync;
    private interface Locked<T> { T run(JSONObject state) throws Exception; }

    NativeNotificationInbox(Path root, String ownerFingerprint, Projector projector, DirectorySync sync) throws IOException {
        if (ownerFingerprint == null || !ownerFingerprint.matches("[a-f0-9]{64}")) throw new SecurityException("Invalid notification owner");
        Path nativeRoot = root.toRealPath();
        if (!root.toAbsolutePath().normalize().equals(nativeRoot)) throw new IOException("Native inbox root must not be a symlink");
        this.owner = ownerFingerprint; this.projector = java.util.Objects.requireNonNull(projector); this.sync = java.util.Objects.requireNonNull(sync);
        directory = nativeRoot.resolve("native-notification-inbox");
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) { Files.createDirectory(directory); sync.sync(nativeRoot); }
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || !directory.equals(directory.toRealPath())) throw new IOException("Invalid native inbox directory");
        file = directory.resolve(owner + ".json"); lock = directory.resolve(owner + ".lock");
    }

    void beginBaseline() throws Exception {
        locked(state -> { state.put("baselineReady", false); save(state); return null; });
    }

    JSONObject acceptLive(JSONObject notification) throws Exception {
        JSONObject copy = checked(notification);
        return locked(state -> {
            String id = copy.getString("id");
            JSONObject seen = state.getJSONObject("seen");
            if (seen.has(id)) return outcome(id, seen.getString(id), false, true);
            // Before the first authoritative baseline, retain new arrivals so
            // they cannot be mistaken for historical rows in that snapshot.
            // Once initialized, foreground/live records can post immediately
            // during reconnect; the later catch-up uses the same durable ids.
            if (!state.getBoolean("initialized")) {
                JSONObject buffered = state.getJSONObject("buffered");
                boolean duplicate = buffered.has(id);
                if (!duplicate && buffered.length() >= MAX_BUFFERED) throw new IOException("Native notification live buffer full");
                if (!duplicate) { buffered.put(id, copy); save(state); }
                return outcome(id, "buffered", false, duplicate);
            }
            project(state, copy);
            String phase = seen.getString(id);
            return outcome(id, phase, "accepted".equals(phase), false);
        });
    }

    private static JSONObject outcome(String id, String phase, boolean presented, boolean duplicate) throws Exception {
        return new JSONObject().put("notificationId", id).put("state", phase)
                .put("retained", true).put("presented", presented).put("duplicate", duplicate);
    }

    void completeBaseline(JSONArray notifications) throws Exception {
        List<JSONObject> snapshot = new ArrayList<>();
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < notifications.length(); i++) {
            JSONObject item = checked(notifications.getJSONObject(i));
            if (!ids.add(item.getString("id"))) throw new IOException("Duplicate notification baseline id");
            snapshot.add(item);
        }
        locked(state -> {
            JSONObject seen = state.getJSONObject("seen"), buffered = state.getJSONObject("buffered");
            List<JSONObject> deliver = new ArrayList<>();
            boolean initial = !state.getBoolean("initialized");
            for (JSONObject item : snapshot) {
                String id = item.getString("id");
                if (seen.has(id)) continue;
                if (buffered.has(id)) {
                    // Preserve the original arrival contents, but the full
                    // authoritative inbox can already know it was read or
                    // expired before this delayed first presentation.
                    buffered.getJSONObject(id).put("readAt", item.get("readAt"))
                            .put("expiresAt", item.get("expiresAt"));
                }
                if (initial && !buffered.has(id)) remember(state, id, "baseline");
                else if (!buffered.has(id)) {
                    if (ignored(item)) remember(state, id, "ignored");
                    else deliver.add(item);
                }
            }
            for (java.util.Iterator<String> keys = buffered.keys(); keys.hasNext();) {
                String id = keys.next();
                if (!seen.has(id)) {
                    JSONObject item = buffered.getJSONObject(id);
                    if (ignored(item)) remember(state, id, "ignored");
                    else deliver.add(item);
                }
            }
            // MAX_BUFFERED bounds pre-activation live arrivals, not a full
            // authoritative catch-up. The receipt/response limits still bound
            // this list, and each platform effect commits its marker first.
            if (seen.length() + deliver.size() > MAX_SEEN) throw new IOException("Native notification receipt capacity exhausted");
            deliver.sort(Comparator.comparingLong(item -> item.optLong("createdAt")));
            state.put("initialized", true).put("baselineReady", true).put("buffered", new JSONObject());
            save(state);
            for (JSONObject item : deliver) project(state, item);
            return null;
        });
    }

    JSONObject status() throws Exception {
        return locked(state -> {
            int accepted = 0, unknown = 0;
            JSONObject seen = state.getJSONObject("seen");
            for (java.util.Iterator<String> keys = seen.keys(); keys.hasNext();) {
                String phase = seen.getString(keys.next());
                if ("accepted".equals(phase)) accepted++;
                else if ("dispatched".equals(phase) || "unknown".equals(phase)) unknown++;
            }
            return new JSONObject().put("initialized", state.getBoolean("initialized"))
                    .put("baselineReady", state.getBoolean("baselineReady"))
                    .put("pendingBuffered", state.getJSONObject("buffered").length())
                    .put("seenCount", seen.length()).put("acceptedCount", accepted).put("unknownCount", unknown);
        });
    }

    private void project(JSONObject state, JSONObject item) throws Exception {
        String id = item.getString("id");
        if (state.getJSONObject("seen").has(id)) return;
        if (ignored(item)) {
            remember(state, id, "ignored"); save(state); return;
        }
        remember(state, id, "dispatched"); save(state);
        boolean accepted;
        try { accepted = projector.post(new JSONObject(item.toString())); }
        catch (Exception error) {
            // error-policy:J1 the durable pre-effect marker survives a partial/ambiguous platform post.
            state.getJSONObject("seen").put(id, "unknown"); save(state); throw error;
        }
        state.getJSONObject("seen").put(id, accepted ? "accepted" : "unknown"); save(state);
    }

    private static boolean ignored(JSONObject item) throws Exception {
        return "low".equals(item.getString("priority")) || !item.isNull("readAt")
                || (!item.isNull("expiresAt") && item.getLong("expiresAt") <= System.currentTimeMillis());
    }

    private void remember(JSONObject state, String id, String phase) throws Exception {
        JSONObject seen = state.getJSONObject("seen");
        if (!seen.has(id) && seen.length() >= MAX_SEEN) throw new IOException("Native notification receipt capacity exhausted");
        seen.put(id, phase);
    }

    static JSONObject checked(JSONObject value) throws Exception {
        JSONObject copy = new JSONObject(value.toString());
        String id = copy.getString("id");
        if (!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new IllegalArgumentException("Invalid notification id");
        copy.put("id", id.toLowerCase(java.util.Locale.ROOT));
        String title = copy.getString("title"), body = copy.optString("body", "");
        if (title.trim().isEmpty() || title.length() > 512 || title.indexOf('\0') >= 0 || body.length() > 4096 || body.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid notification text");
        if (!java.util.Arrays.asList("reminder", "task", "workflow", "agent", "approval", "message", "health", "system", "general").contains(copy.getString("category"))
                || !java.util.Arrays.asList("low", "normal", "high", "urgent").contains(copy.getString("priority"))) throw new IllegalArgumentException("Invalid notification delivery category");
        for (String field : new String[]{"createdAt", "readAt", "expiresAt"}) {
            if (!"createdAt".equals(field) && (!copy.has(field) || copy.isNull(field))) copy.put(field, JSONObject.NULL);
            else {
                Object raw = copy.get(field);
                if (!(raw instanceof Number)) throw new IllegalArgumentException("Invalid notification timestamp");
                double numeric = ((Number) raw).doubleValue();
                if (!Double.isFinite(numeric) || numeric != Math.rint(numeric) || numeric < 0 || numeric > 9007199254740991L)
                    throw new IllegalArgumentException("Invalid notification timestamp");
            }
        }
        copy.put("body", body);
        if (copy.toString().getBytes(StandardCharsets.UTF_8).length > 16384) throw new IllegalArgumentException("Notification record too large");
        return copy;
    }

    private <T> T locked(Locked<T> operation) throws Exception {
        synchronized (LOCKS.computeIfAbsent(file, ignored -> new Object())) {
            if (Files.isSymbolicLink(lock)) throw new IOException("Invalid inbox lock");
            try (FileChannel channel = FileChannel.open(lock, StandardOpenOption.CREATE, StandardOpenOption.WRITE); FileLock held = channel.lock()) {
                if (!held.isValid()) throw new IOException("Notification inbox lock unavailable");
                return operation.run(load());
            }
        }
    }
    private JSONObject load() throws Exception {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return new JSONObject().put("version", 1).put("owner", owner)
                .put("initialized", false).put("baselineReady", false).put("seen", new JSONObject()).put("buffered", new JSONObject());
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) throw new IOException("Invalid inbox journal");
        JSONObject state = new JSONObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        if (state.getInt("version") != 1 || !owner.equals(state.getString("owner"))) throw new SecurityException("Notification inbox owner changed");
        if (state.getJSONObject("seen").length() > MAX_SEEN || state.getJSONObject("buffered").length() > MAX_BUFFERED) throw new IOException("Inbox journal capacity exceeded");
        JSONObject seen = state.getJSONObject("seen");
        for (java.util.Iterator<String> keys = seen.keys(); keys.hasNext();) {
            String id = keys.next();
            if (!id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
                    || !java.util.Arrays.asList("baseline", "ignored", "dispatched", "accepted", "unknown").contains(seen.getString(id))) throw new IOException("Invalid inbox receipt phase");
        }
        return state;
    }
    private void save(JSONObject state) throws IOException {
        byte[] bytes = state.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("Notification journal too large");
        Path temporary = Files.createTempFile(directory, "notification-", ".tmp");
        try {
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
                java.nio.ByteBuffer buffer = java.nio.ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) channel.write(buffer);
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); sync.sync(directory);
        } finally { Files.deleteIfExists(temporary); }
    }
}
