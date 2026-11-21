// spec/os/android/notificationMirror.md, "Story: Mirror only the notifications I allowed"; spec/os/android/notificationMirror.md, "Story: Show only current notices from apps I picked"; spec/os/android/notificationMirror.md, "Story: Keep a short private history only while I allow it"; spec/os/android/notificationMirror.md, "Story: Act on exactly the notice I see"
package ai.eliza.plugins.notifications;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class NotificationMirrorAdapter {
    private record Handle(String key, long handle, long postedAt) {}
    private record Queued(long instance, long generation, String key, String app, long postedAt, boolean removal) {}
    private record Record(String app, long at) {}
    private enum File { NONE, KEPT, UNDELETED }

    private long revision, nextInstance, generation, nextHandle, bound;
    private boolean ownerEnabled, historyConsent, paused, granted;
    private List<String> selected, changedSigners;
    private List<Queued> queue;
    private List<Handle> handles;
    private List<Record> history;
    private File file;
    private List<String> out;

    public static void main(String[] args) throws Exception {
        NotificationMirrorAdapter adapter = new NotificationMirrorAdapter();
        adapter.reset();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        for (String line; (line = input.readLine()) != null;) {
            if (line.isBlank()) continue;
            try { output.println(adapter.answer(line)); }
            catch (RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
        }
    }

    private void reset() {
        revision = 0; nextInstance = 1; generation = 0; nextHandle = 1; bound = 0;
        ownerEnabled = false; historyConsent = false; paused = false; granted = false;
        selected = new ArrayList<>(); changedSigners = new ArrayList<>(); queue = new ArrayList<>(); handles = new ArrayList<>();
        history = new ArrayList<>(); file = File.NONE; out = new ArrayList<>();
    }

    private String answer(String line) {
        Map<String, Object> request = object(new Json(line).value());
        Object event = request.containsKey("event") ? request.get("event") : request.get("raw");
        if (event == null) {
            reset();
            return "{\"state\":" + encode() + ",\"out\":[]}";
        }
        out = new ArrayList<>();
        boolean accepted = step(object(event));
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + encode() + ",\"out\":[" + String.join(",", out) + "]}";
    }

    private boolean collecting() { return NotificationMirrorPolicy.active(ownerEnabled, paused, granted); }
    private boolean keepsHistory() { return NotificationMirrorPolicy.keepsHistory(granted, ownerEnabled, historyConsent, paused); }
    private boolean isBound() { return bound > 0; }

    private void purge(boolean deleted) {
        generation++;
        handles = new ArrayList<>();
        if (deleted || file == File.NONE) { file = File.NONE; history = new ArrayList<>(); }
        else file = File.UNDELETED;
    }

    private static boolean focused(Map<String, Object> facts) {
        return flag(facts.get("foreground")) && flag(facts.get("unlocked")) && flag(facts.get("focused"));
    }

    private boolean admits(String source, String app) {
        boolean selectedValid = selected.contains(app) && !changedSigners.contains(app);
        return switch (source) {
            case "ForeignAppNotice" -> NotificationMirrorPolicy.admits(true, false, true, selectedValid);
            case "OwnAppNotice" -> NotificationMirrorPolicy.admits(true, true, true, selectedValid);
            case "OtherUserNotice" -> NotificationMirrorPolicy.admits(false, false, true, selectedValid);
            case "MismatchedUidNotice" -> NotificationMirrorPolicy.admits(true, false, false, selectedValid);
            default -> throw new IllegalArgumentException("unknown source " + source);
        };
    }

    private List<Handle> withHandle(List<Handle> rows, Handle row) {
        List<Handle> next = new ArrayList<>();
        for (Handle h : rows) if (!h.key().equals(row.key())) next.add(h);
        next.add(row);
        if (next.size() > NotificationMirrorPolicy.MAX_ACTIVE) next.remove(0);
        return next;
    }

    private List<Handle> without(String key) {
        List<Handle> next = new ArrayList<>();
        for (Handle h : handles) if (!h.key().equals(key)) next.add(h);
        return next;
    }

    private boolean step(Map<String, Object> e) {
        String type = text(e.get("type"));
        switch (type) {
            case "resume" -> {
                if (!paused) return false;
                paused = false; generation++; handles = new ArrayList<>();
            }
            case "observeAccess" -> {
                boolean now = flag(e.get("granted"));
                if (now == granted) return false;
                if (!now) purge(flag(e.get("deleted")));
                granted = now;
            }
            case "pause" -> {
                if (paused) return false;
                purge(flag(e.get("deleted")));
                paused = true;
            }
            case "observeSignerChanged" -> {
                String app = text(e.get("app"));
                if (!selected.contains(app) || changedSigners.contains(app)) return false;
                changedSigners.add(app);
            }
            case "chooseApps" -> {
                List<String> requested = strings(e.get("requested"));
                Map<String, Boolean> prior = new HashMap<>();
                for (String app : changedSigners) prior.put(app, false);
                if (!focused(object(e.get("facts"))) || number(e.get("expectedRevision")) != revision) return false;
                try { NotificationMirrorPolicy.checkSelection(requested, new HashSet<>(strings(e.get("visible"))), prior); }
                catch (NotificationMirrorPolicy.Rejected refused) { return false; }
                boolean deleted = flag(e.get("deleted"));
                purge(deleted);
                if (deleted && flag(e.get("committed"))) { selected = new ArrayList<>(requested); changedSigners = new ArrayList<>(); revision++; }
            }
            case "saveSettings" -> {
                if (!focused(object(e.get("facts"))) || number(e.get("expectedRevision")) != revision) return false;
                boolean deleted = flag(e.get("deleted"));
                purge(deleted);
                if (deleted && flag(e.get("committed"))) { ownerEnabled = flag(e.get("ownerEnabled")); historyConsent = flag(e.get("historyConsent")); revision++; }
            }
            case "listNotice" -> {
                String key = text(e.get("key"));
                long postedAt = number(e.get("postedAt"));
                if (!(collecting() && isBound() && flag(e.get("unlocked")))) { handles = new ArrayList<>(); return true; }
                if (!admits(text(e.get("source")), text(e.get("app")))) return true;
                for (Handle h : handles) if (h.key().equals(key) && h.postedAt() == postedAt) return true;
                handles = withHandle(handles, new Handle(key, nextHandle++, postedAt));
            }
            case "enqueueCallback" -> {
                long instance = number(e.get("instance"));
                if (instance < 1 || instance >= nextInstance || queue.size() >= 64) return false;
                String key = text(e.get("key"));
                queue.add(new Queued(instance, generation, key, text(e.get("app")), number(e.get("postedAt")), flag(e.get("removal"))));
                handles = without(key);
            }
            case "refuseCallback" -> { generation++; handles = new ArrayList<>(); queue = new ArrayList<>(); }
            case "connectListener" -> { bound = nextInstance++; generation++; handles = new ArrayList<>(); }
            case "disconnectListener" -> {
                long instance = number(e.get("instance"));
                if (bound == 0 || bound != instance) return false;
                bound = 0; generation++; handles = new ArrayList<>();
                queue.removeIf(c -> c.instance() == instance);
            }
            case "redactRows" -> { generation++; handles = new ArrayList<>(); }
            case "runCallback" -> {
                if (queue.isEmpty()) return false;
                Queued c = queue.remove(0);
                if (c.generation() != generation || bound != c.instance()) return true;
                if (!collecting()) { handles = new ArrayList<>(); return true; }
                List<Handle> others = without(c.key());
                if (!admits(text(e.get("source")), c.app())) { handles = others; return true; }
                boolean recording = keepsHistory() && file != File.UNDELETED;
                if (recording && !flag(e.get("appended"))) { handles = new ArrayList<>(); return true; }
                handles = !c.removal() && flag(e.get("unlocked")) ? withHandle(others, new Handle(c.key(), nextHandle, c.postedAt())) : others;
                nextHandle++;
                if (recording) {
                    List<Record> rows = new ArrayList<>();
                    rows.add(new Record(c.app(), number(e.get("now"))));
                    List<Record> kept = file == File.KEPT ? history : List.of();
                    rows.addAll(kept.size() < NotificationMirrorPolicy.MAX_HISTORY ? kept : kept.subList(0, kept.size() - 1));
                    history = rows; file = File.KEPT;
                }
            }
            case "retryHistoryDeletion" -> {
                if (file != File.UNDELETED) return false;
                if (flag(e.get("deleted"))) { file = File.NONE; history = new ArrayList<>(); }
            }
            case "clearHistory" -> {
                if (!focused(object(e.get("facts")))) return false;
                purge(flag(e.get("deleted")));
                out.add(file == File.NONE ? "{\"tag\":\"HistoryCleared\"}" : "{\"tag\":\"HistoryNotCleared\"}");
            }
            case "showHistory" -> {
                if (!focused(object(e.get("facts")))) return false;
                long now = number(e.get("now"));
                if (!(keepsHistory() && file == File.KEPT)) { out.add("{\"tag\":\"HistoryWithheld\"}"); return true; }
                List<Record> rows = new ArrayList<>();
                for (Record r : history) if (NotificationMirrorPolicy.retained(r.at(), now) && !changedSigners.contains(r.app())) rows.add(r);
                history = rows;
                out.add("{\"tag\":\"HistoryShown\",\"now\":" + now + ",\"rows\":" + records(rows) + "}");
            }
            case "requestAction" -> {
                long handle = number(e.get("handle"));
                String action = text(e.get("rowAction"));
                boolean live = false;
                for (Handle h : handles) if (h.handle() == handle) live = true;
                boolean admitted = focused(object(e.get("facts"))) && collecting() && isBound() && live && rowAllows(object(e.get("row")), action);
                out.add(admitted ? "{\"tag\":\"ActionRequested\",\"handle\":" + handle + ",\"rowAction\":" + quote(action) + ",\"confirmation\":" + quote(text(e.get("confirmation"))) + "}" : "{\"tag\":\"ActionRefused\"}");
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        }
        return true;
    }

    private static boolean rowAllows(Map<String, Object> row, String action) {
        if (!"CurrentRow".equals(text(row.get("tag")))) return false;
        if (!"OpenRow".equals(action)) return flag(row.get("clearable"));
        boolean secret = "SecretNotice".equals(text(row.get("look")));
        String intent = text(row.get("intent"));
        int postingUid = 10_001;
        return NotificationMirrorPolicy.canOpen(secret, !"NoIntent".equals(intent), "PostingAppIntent".equals(intent) ? postingUid : postingUid + 1, postingUid);
    }

    private String encode() {
        StringBuilder s = new StringBuilder("{\"revision\":").append(revision)
            .append(",\"ownerEnabled\":").append(ownerEnabled).append(",\"historyConsent\":").append(historyConsent)
            .append(",\"paused\":").append(paused).append(",\"granted\":").append(granted)
            .append(",\"selected\":").append(texts(selected)).append(",\"changedSigners\":").append(texts(changedSigners))
            .append(",\"listener\":").append(bound > 0 ? "{\"tag\":\"Bound\",\"instance\":" + bound + "}" : "{\"tag\":\"Unbound\"}")
            .append(",\"nextInstance\":").append(nextInstance).append(",\"generation\":").append(generation).append(",\"queue\":[");
        for (int i = 0; i < queue.size(); i++) {
            Queued c = queue.get(i);
            s.append(i == 0 ? "" : ",").append("{\"instance\":").append(c.instance()).append(",\"generation\":").append(c.generation())
                .append(",\"key\":").append(quote(c.key())).append(",\"app\":").append(quote(c.app()))
                .append(",\"postedAt\":").append(c.postedAt()).append(",\"removal\":").append(c.removal()).append('}');
        }
        s.append("],\"handles\":[");
        for (int i = 0; i < handles.size(); i++) {
            Handle h = handles.get(i);
            s.append(i == 0 ? "" : ",").append("{\"key\":").append(quote(h.key())).append(",\"handle\":").append(h.handle()).append(",\"postedAt\":").append(h.postedAt()).append('}');
        }
        s.append("],\"nextHandle\":").append(nextHandle).append(",\"historyFile\":").append(switch (file) {
            case NONE -> "{\"tag\":\"NoFile\"}";
            case UNDELETED -> "{\"tag\":\"UndeletedFile\"}";
            case KEPT -> "{\"tag\":\"KeptFile\",\"rows\":" + records(history) + "}";
        });
        return s.append('}').toString();
    }

    private static String records(List<Record> rows) {
        List<String> parts = new ArrayList<>();
        for (Record r : rows) parts.add("{\"app\":" + quote(r.app()) + ",\"at\":" + r.at() + "}");
        return "[" + String.join(",", parts) + "]";
    }

    private static String texts(List<String> values) {
        List<String> parts = new ArrayList<>();
        for (String v : values) parts.add(quote(v));
        return "[" + String.join(",", parts) + "]";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("not an object: " + value);
        return (Map<String, Object>) value;
    }

    private static List<String> strings(Object value) {
        if (!(value instanceof List<?> list)) throw new IllegalArgumentException("not a list: " + value);
        List<String> out = new ArrayList<>();
        for (Object item : list) out.add(text(item));
        return out;
    }

    private static String text(Object value) {
        if (!(value instanceof String s)) throw new IllegalArgumentException("not a string: " + value);
        return s;
    }

    private static boolean flag(Object value) {
        if (!(value instanceof Boolean b)) throw new IllegalArgumentException("not a boolean: " + value);
        return b;
    }

    private static long number(Object value) {
        if (!(value instanceof Long n) || Math.abs(n) > 9_007_199_254_740_991L) throw new IllegalArgumentException("not a safe whole number: " + value);
        return n;
    }

    private static String quote(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    private static final class Json {
        private final String text;
        private int at;

        Json(String text) { this.text = text; }

        Object value() {
            skip();
            char c = text.charAt(at);
            if (c == '{') {
                Map<String, Object> out = new LinkedHashMap<>();
                at++;
                skip();
                if (text.charAt(at) == '}') { at++; return out; }
                do {
                    skip();
                    String key = (String) value();
                    skip();
                    if (text.charAt(at++) != ':') throw new IllegalArgumentException("expected : at " + at);
                    out.put(key, value());
                    skip();
                } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != '}') throw new IllegalArgumentException("malformed object at " + at);
                return out;
            }
            if (c == '[') {
                List<Object> out = new ArrayList<>();
                at++;
                skip();
                if (text.charAt(at) == ']') { at++; return out; }
                do { out.add(value()); skip(); } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != ']') throw new IllegalArgumentException("malformed array at " + at);
                return out;
            }
            if (c == '"') {
                StringBuilder out = new StringBuilder();
                for (at++; text.charAt(at) != '"'; at++) {
                    char ch = text.charAt(at);
                    if (ch != '\\') { out.append(ch); continue; }
                    char escaped = text.charAt(++at);
                    switch (escaped) {
                        case 'n' -> out.append('\n');
                        case 't' -> out.append('\t');
                        case 'r' -> out.append('\r');
                        case 'b' -> out.append('\b');
                        case 'f' -> out.append('\f');
                        case 'u' -> { out.append((char) Integer.parseInt(text.substring(at + 1, at + 5), 16)); at += 4; }
                        default -> out.append(escaped);
                    }
                }
                at++;
                return out.toString();
            }
            if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
            if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
            if (text.startsWith("null", at)) { at += 4; return null; }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            String number = text.substring(start, at);
            if (number.isEmpty()) throw new IllegalArgumentException("unexpected " + c + " at " + start);
            return number.matches("-?[0-9]+") ? (Object) Long.parseLong(number) : (Object) Double.parseDouble(number);
        }

        private void skip() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
    }
}
