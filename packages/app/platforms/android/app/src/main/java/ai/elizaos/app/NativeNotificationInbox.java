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
    interface AuthorityCheck { void current() throws Exception; }
    private static final int MAX_SEEN = 10000, MAX_BUFFERED = 128, MAX_BYTES = 4 * 1024 * 1024;
    private static final ConcurrentHashMap<Path, Object> LOCKS = new ConcurrentHashMap<>();
    private final Path directory, file, lock;
    private final String owner;
    private final Projector projector;
    private final DirectorySync sync;
    private final AuthorityCheck authority;
    private interface Locked<T> { T run(JSONObject state) throws Exception; }

    NativeNotificationInbox(Path root, String ownerFingerprint, Projector projector, DirectorySync sync) throws IOException {
        this(root, ownerFingerprint, projector, sync, () -> {});
    }

    NativeNotificationInbox(Path root, String ownerFingerprint, Projector projector, DirectorySync sync, AuthorityCheck authority) throws IOException {
        if (ownerFingerprint == null || !ownerFingerprint.matches("[a-f0-9]{64}")) throw new SecurityException("Invalid notification owner");
        Path nativeRoot = root.toRealPath();
        if (!root.toAbsolutePath().normalize().equals(nativeRoot)) throw new IOException("Native inbox root must not be a symlink");
        this.authority = java.util.Objects.requireNonNull(authority);
        this.owner = ownerFingerprint; this.projector = java.util.Objects.requireNonNull(projector); this.sync = java.util.Objects.requireNonNull(sync);
        directory = nativeRoot.resolve("native-notification-inbox");
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) { Files.createDirectory(directory); sync.sync(nativeRoot); }
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || !directory.equals(directory.toRealPath())) throw new IOException("Invalid native inbox directory");
        file = directory.resolve(owner + ".json"); lock = directory.resolve(owner + ".lock");
    }

    void beginBaseline() throws Exception {
        locked(state -> { state.put("baselineReady", false); save(state); return null; });
    }

    /** The request cursor is durable; reconnect and process restart resume the same append fence. */
    JSONObject pageCursor() throws Exception {
        return locked(this::cursor);
    }

    void restartEpoch() throws Exception {
        locked(state -> { state.put("resetEpoch", true).put("page", JSONObject.NULL); save(state); return null; });
    }

    JSONObject acceptLive(JSONObject notification) throws Exception {
        JSONObject copy = checked(notification);
        return locked(state -> {
            String id = copy.getString("id");
            JSONObject seen = state.getJSONObject("seen"), legacy = state.getJSONObject("legacySeen");
            if (seen.has(id)) return outcome(id, seen.getJSONObject(id).getString("phase"), false, true);
            if (legacy.has(id)) return outcome(id, legacy.getString(id), false, true);
            JSONObject buffered = state.getJSONObject("buffered");
            if (buffered.has(id)) return outcome(id, "buffered", false, true);
            if (copy.getString("nativeEpoch").equals(state.optString("nativeEpoch"))
                && copy.getLong("nativeSequence") <= state.getLong("closedThroughSequence"))
                return outcome(id, "closed", false, true);
            if (!state.getBoolean("initialized") || !copy.getString("nativeEpoch").equals(state.optString("nativeEpoch"))) {
                if (buffered.length() >= MAX_BUFFERED) throw new IOException("Native notification live buffer full");
                buffered.put(id, copy); save(state);
                return outcome(id, "buffered", false, false);
            }
            project(state, copy);
            String phase = seen.getJSONObject(id).getString("phase");
            return outcome(id, phase, "accepted".equals(phase), false);
        });
    }

    private static JSONObject outcome(String id, String phase, boolean presented, boolean duplicate) throws Exception {
        return new JSONObject().put("notificationId", id).put("state", phase)
                .put("retained", true).put("presented", presented).put("duplicate", duplicate);
    }

    /** Only a fully validated, fully processed page closes its range. An incomplete
     * page closes through its last emitted row; only complete=true closes deleted tail gaps. */
    boolean acceptPage(JSONObject envelope, JSONObject requestedCursor) throws Exception {
        JSONObject page = NativeNotificationWire.page(envelope, requestedCursor);
        return locked(state -> {
            JSONObject actual = cursor(state);
            if (!actual.toString().equals(requestedCursor.toString()))
                throw new IOException("Notification page cursor changed");
            String epoch = page.getString("nativeEpoch");
            if (!epoch.equals(state.optString("nativeEpoch"))) {
                boolean changedEpoch = !state.isNull("nativeEpoch");
                JSONObject old = state.getJSONObject("seen"), legacy = state.getJSONObject("legacySeen");
                for (java.util.Iterator<String> keys = old.keys(); keys.hasNext();) {
                    String id = keys.next(); legacy.put(id, old.getJSONObject(id).getString("phase"));
                }
                state.put("seen", new JSONObject()).put("nativeEpoch", epoch)
                    .put("closedThroughSequence", 0);
                if (changedEpoch) state.put("initialized", false);
            }
            state.put("resetEpoch", false);
            JSONObject seen = state.getJSONObject("seen"), buffered = state.getJSONObject("buffered");
            boolean initial = !state.getBoolean("initialized");
            JSONArray records = page.getJSONArray("notifications");
            // Commit the fixed fence before any effect. If a candidate fails,
            // this page remains unfinished and its range remains open.
            state.put("page", new JSONObject().put("nativeEpoch", epoch)
                .put("afterSequence", requestedCursor.getLong("afterSequence"))
                .put("throughSequence", page.getLong("throughSequence")));
            save(state);
            for (int i = 0; i < records.length(); i++) {
                JSONObject item = records.getJSONObject(i);
                String id = item.getString("id");
                if (buffered.has(id)) {
                    JSONObject arrival = buffered.getJSONObject(id);
                    arrival.put("readAt", item.get("readAt")).put("expiresAt", item.get("expiresAt"));
                    // Migrated v1 arrivals obtain the authoritative coordinates.
                    arrival.put("nativeEpoch", epoch).put("nativeSequence", item.getLong("nativeSequence"));
                    save(state);
                } else if (!seen.has(id) && !state.getJSONObject("legacySeen").has(id)) {
                    if (initial) remember(state, item, "baseline");
                    else project(state, item);
                }
            }
            boolean complete = page.getBoolean("complete");
            if (complete) {
                List<JSONObject> arrivals = new ArrayList<>();
                for (java.util.Iterator<String> keys = buffered.keys(); keys.hasNext();) {
                    JSONObject arrival = buffered.getJSONObject(keys.next());
                    if (epoch.equals(arrival.optString("nativeEpoch"))) arrivals.add(arrival);
                }
                arrivals.sort(Comparator.comparingLong(item -> item.optLong("nativeSequence")));
                for (JSONObject item : arrivals) {
                    project(state, item);
                    buffered.remove(item.getString("id")); save(state);
                }
                state.put("initialized", true).put("baselineReady", true).put("page", JSONObject.NULL);
            } else {
                state.getJSONObject("page").put("afterSequence", page.getLong("nextSequence"));
            }
            long closed = page.getLong("nextSequence");
            state.put("closedThroughSequence", closed);
            List<String> compact = new ArrayList<>();
            for (java.util.Iterator<String> keys = seen.keys(); keys.hasNext();) {
                String id = keys.next(); JSONObject receipt = seen.getJSONObject(id);
                String phase = receipt.getString("phase");
                if (epoch.equals(receipt.getString("nativeEpoch")) && receipt.getLong("nativeSequence") <= closed
                    && !"unknown".equals(phase) && !"dispatched".equals(phase)) compact.add(id);
            }
            for (String id : compact) seen.remove(id);
            save(state);
            return complete;
        });
    }

    private JSONObject cursor(JSONObject state) throws Exception {
        if (state.optBoolean("resetEpoch")) return new JSONObject().put("afterSequence", 0);
        JSONObject page = state.optJSONObject("page");
        if (page != null) return new JSONObject(page.toString());
        JSONObject result = new JSONObject().put("afterSequence", state.getLong("closedThroughSequence"));
        if (!state.isNull("nativeEpoch")) result.put("nativeEpoch", state.getString("nativeEpoch"));
        return result;
    }

    JSONObject status() throws Exception {
        return locked(state -> {
            int accepted = 0, unknown = 0;
            JSONObject seen = state.getJSONObject("seen"), legacy = state.getJSONObject("legacySeen");
            for (JSONObject receipts : new JSONObject[]{seen, legacy}) {
                for (java.util.Iterator<String> keys = receipts.keys(); keys.hasNext();) {
                    String id = keys.next();
                    String phase = receipts == seen ? receipts.getJSONObject(id).getString("phase") : receipts.getString(id);
                    if ("accepted".equals(phase)) accepted++;
                    else if ("dispatched".equals(phase) || "unknown".equals(phase)) unknown++;
                }
            }
            return new JSONObject().put("initialized", state.getBoolean("initialized"))
                    .put("baselineReady", state.getBoolean("baselineReady"))
                    .put("nativeEpoch", state.get("nativeEpoch")).put("closedThroughSequence", state.getLong("closedThroughSequence"))
                    .put("pendingBuffered", state.getJSONObject("buffered").length())
                    .put("seenCount", seen.length()).put("legacySeenCount", legacy.length())
                    .put("receiptCapacity", MAX_SEEN).put("liveBufferCapacity", MAX_BUFFERED).put("journalMaximumBytes", MAX_BYTES)
                    .put("acceptedCount", accepted).put("unknownCount", unknown);
        });
    }

    private void project(JSONObject state, JSONObject item) throws Exception {
        String id = item.getString("id");
        if (state.getJSONObject("seen").has(id) || state.getJSONObject("legacySeen").has(id)) return;
        if (ignored(item)) { remember(state, item, "ignored"); save(state); return; }
        remember(state, item, "dispatched"); save(state);
        boolean accepted;
        try { authority.current(); accepted = projector.post(new JSONObject(item.toString())); }
        catch (Exception error) {
            // error-policy:J1 the durable pre-effect marker survives a partial/ambiguous platform post.
            state.getJSONObject("seen").getJSONObject(id).put("phase", "unknown"); save(state); throw error;
        }
        state.getJSONObject("seen").getJSONObject(id).put("phase", accepted ? "accepted" : "unknown"); save(state);
    }

    private static boolean ignored(JSONObject item) throws Exception {
        return "low".equals(item.getString("priority")) || !item.isNull("readAt")
                || (!item.isNull("expiresAt") && item.getLong("expiresAt") <= System.currentTimeMillis());
    }

    private void remember(JSONObject state, JSONObject item, String phase) throws Exception {
        JSONObject seen = state.getJSONObject("seen"); String id = item.getString("id");
        if (!seen.has(id) && seen.length() >= MAX_SEEN) throw new IOException("Native notification receipt capacity exhausted");
        seen.put(id, new JSONObject().put("phase", phase).put("nativeEpoch", item.getString("nativeEpoch"))
            .put("nativeSequence", item.getLong("nativeSequence")));
    }

    static JSONObject checked(JSONObject value) throws Exception {
        JSONObject copy = new JSONObject(value.toString());
        String id = copy.getString("id");
        if (!id.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new IllegalArgumentException("Invalid notification id");
        copy.put("id", id.toLowerCase(java.util.Locale.ROOT));
        String epoch = copy.getString("nativeEpoch");
        if (!epoch.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) throw new IllegalArgumentException("Invalid notification epoch");
        copy.put("nativeEpoch", epoch.toLowerCase(java.util.Locale.ROOT));
        NativeNotificationWire.sequence(copy, "nativeSequence", false);
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
                authority.current();
                return operation.run(load());
            }
        }
    }
    private JSONObject load() throws Exception {
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return new JSONObject().put("version", 2).put("owner", owner)
                .put("initialized", false).put("baselineReady", false).put("seen", new JSONObject()).put("legacySeen", new JSONObject())
                .put("nativeEpoch", JSONObject.NULL).put("closedThroughSequence", 0).put("page", JSONObject.NULL).put("buffered", new JSONObject());
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_BYTES) throw new IOException("Invalid inbox journal");
        JSONObject state = new JSONObject(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        int version = state.getInt("version");
        if ((version != 1 && version != 2) || !owner.equals(state.getString("owner"))) throw new SecurityException("Notification inbox owner changed");
        if (state.getJSONObject("seen").length() > MAX_SEEN || state.getJSONObject("buffered").length() > MAX_BUFFERED) throw new IOException("Inbox journal capacity exceeded");
        if (version == 1) {
            state.put("legacySeen", state.getJSONObject("seen")).put("seen", new JSONObject()).put("version", 2)
                .put("nativeEpoch", JSONObject.NULL).put("closedThroughSequence", 0).put("page", JSONObject.NULL);
        }
        NativeNotificationWire.sequence(state, "closedThroughSequence", true);
        for (String field : new String[]{"seen", "legacySeen"}) {
            JSONObject receipts = state.getJSONObject(field);
            for (java.util.Iterator<String> keys = receipts.keys(); keys.hasNext();) {
                String id = keys.next();
                String phase = "seen".equals(field) ? receipts.getJSONObject(id).getString("phase") : receipts.getString(id);
                if (!id.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
                    || !java.util.Arrays.asList("baseline", "ignored", "dispatched", "accepted", "unknown").contains(phase)) throw new IOException("Invalid inbox receipt phase");
                if ("seen".equals(field)) NativeNotificationWire.sequence(receipts.getJSONObject(id), "nativeSequence", false);
            }
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
