// spec/os/browser/surface/profiles.md, "Story: Keep two sites' storage apart unless I share a profile"; spec/os/browser/surface/profiles.md, "Story: Sign the device out of websites"
package ai.eliza.plugins.browsersurface;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ProfilePurgeReplay {
    private static final Pattern TYPE = Pattern.compile("\"type\"\\s*:\\s*\"(\\w+)\"");

    private static final class Life {
        final int name;
        final String owner, key;
        long usedAt;

        Life(int name, String owner, String key, long usedAt) {
            this.name = name;
            this.owner = owner;
            this.key = key;
            this.usedAt = usedAt;
        }
    }

    private final Map<String, Life> store = new LinkedHashMap<>();
    private final Map<Integer, String> surfaces = new LinkedHashMap<>();
    private final List<Life> clearing = new ArrayList<>();
    private int lastProfile, lastSurface, purged;
    private long serial;
    private boolean cookieLeft;
    private String request = "{\"tag\":\"NoPurge\"}", answer = "{\"tag\":\"NoAnswer\"}";

    private void reset() {
        store.clear();
        surfaces.clear();
        clearing.clear();
        lastProfile = lastSurface = purged = 0;
        serial = 0;
        cookieLeft = false;
        request = "{\"tag\":\"NoPurge\"}";
        answer = "{\"tag\":\"NoAnswer\"}";
    }

    private static String keyedName(String owner, String key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(("keyed\u0000" + owner + "\u0000" + key).getBytes(StandardCharsets.UTF_8));
            return BrowserProfilePolicy.KEYED_PREFIX + HexFormat.of().formatHex(digest).substring(0, 48);
        } catch (NoSuchAlgorithmException missing) {
            throw new IllegalStateException(missing);
        }
    }

    private void createSurface(String owner, String key, long now) {
        String name = key.isEmpty() ? BrowserProfilePolicy.EPHEMERAL_PREFIX + ++serial : keyedName(owner, key);
        Life life = store.get(name);
        if (life == null) store.put(name, new Life(++lastProfile, owner, key, now));
        else life.usedAt = now;
        surfaces.put(++lastSurface, name);
    }

    private void closeSurface(int id, long now) {
        String name = surfaces.remove(id);
        if (BrowserProfilePolicy.ephemeral(name)) store.remove(name);
        else store.get(name).usedAt = now;
    }

    private void retire(List<String> names) {
        surfaces.values().removeIf(names::contains);
        for (String name : names) store.remove(name);
    }

    private void clear(String selector, List<String> closing) {
        List<String> names = closing.stream().filter(store::containsKey).toList();
        clearing.clear();
        for (String name : names) clearing.add(store.get(name));
        retire(names);
        request = selector;
        purged = names.size();
        cookieLeft = false;
        answer = names.isEmpty() ? "{\"tag\":\"Cleared\",\"purged\":0,\"clean\":true}" : "{\"tag\":\"NoAnswer\"}";
    }

    private void purgeIdle(long idleMs, long now) {
        List<String> names = store.entrySet().stream()
                .filter(entry -> BrowserProfilePolicy.keyed(entry.getKey()) && !surfaces.containsValue(entry.getKey())
                        && BrowserProfilePolicy.expired(entry.getValue().usedAt, now, idleMs))
                .map(Map.Entry::getKey).toList();
        retire(names);
        request = "{\"tag\":\"ByIdle\",\"idleMs\":" + idleMs + ",\"now\":" + now + "}";
        purged = names.size();
        cookieLeft = false;
        answer = "{\"tag\":\"Counted\",\"purged\":" + purged + "}";
    }

    private void cookiesRemoved(boolean left) {
        clearing.remove(0);
        cookieLeft = cookieLeft || left;
        if (clearing.isEmpty()) answer = "{\"tag\":\"Cleared\",\"purged\":" + purged + ",\"clean\":" + !cookieLeft + "}";
    }

    private static String text(String body, String field) {
        Matcher value = Pattern.compile("\"" + field + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(body);
        if (!value.find()) throw new IllegalArgumentException("an event without " + field + ": " + body);
        return value.group(1).replace("\\\"", "\"").replace("\\\\", "\\");
    }

    private static long number(String body, String field) {
        Matcher value = Pattern.compile("\"" + field + "\"\\s*:\\s*(-?\\d+)").matcher(body);
        if (!value.find()) throw new IllegalArgumentException("an event without " + field + ": " + body);
        return Long.parseLong(value.group(1));
    }

    private static boolean flag(String body, String field) {
        Matcher value = Pattern.compile("\"" + field + "\"\\s*:\\s*(true|false)").matcher(body);
        if (!value.find()) throw new IllegalArgumentException("an event without " + field + ": " + body);
        return Boolean.parseBoolean(value.group(1));
    }

    private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private boolean apply(String type, String body) {
        switch (type) {
            case "createSurface" -> {
                String owner = text(body, "owner"), key = text(body, "key");
                if (owner.isEmpty() || (!key.isEmpty() && !BrowserProfilePolicy.validKey(key))) return false;
                createSurface(owner, key, number(body, "now"));
            }
            case "closeSurface" -> {
                long id = number(body, "id");
                if (id < 1 || id > Integer.MAX_VALUE || !surfaces.containsKey((int) id)) return false;
                closeSurface((int) id, number(body, "now"));
            }
            case "purgeKey" -> {
                String owner = text(body, "owner"), key = text(body, "key");
                if (owner.isEmpty() || !BrowserProfilePolicy.validKey(key) || !clearing.isEmpty()) return false;
                clear("{\"tag\":\"ByKey\",\"owner\":" + quote(owner) + ",\"key\":" + quote(key) + "}", List.of(keyedName(owner, key)));
            }
            case "purgeEverything" -> {
                if (!clearing.isEmpty()) return false;
                clear("{\"tag\":\"Everything\"}", BrowserProfilePolicy.surfaceProfiles(store.keySet()));
            }
            case "purgeIdle" -> {
                long idleMs = number(body, "idleMs");
                if (!BrowserProfilePolicy.validIdle(idleMs) || !clearing.isEmpty()) return false;
                purgeIdle(idleMs, number(body, "now"));
            }
            case "cookiesRemoved" -> {
                if (clearing.isEmpty()) return false;
                cookiesRemoved(flag(body, "left"));
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        }
        return true;
    }

    private String state() {
        List<String> profiles = store.values().stream()
                .map(p -> "{\"name\":" + p.name + ",\"owner\":" + quote(p.owner) + ",\"key\":" + quote(p.key) + ",\"usedAt\":" + p.usedAt + "}")
                .toList();
        List<String> open = surfaces.entrySet().stream()
                .map(s -> "{\"id\":" + s.getKey() + ",\"profile\":" + store.get(s.getValue()).name + "}")
                .toList();
        List<String> pending = clearing.stream().map(p -> String.valueOf(p.name)).toList();
        return "{\"profiles\":[" + String.join(",", profiles) + "],\"surfaces\":[" + String.join(",", open)
                + "],\"lastProfile\":" + lastProfile + ",\"lastSurface\":" + lastSurface + ",\"request\":" + request
                + ",\"clearing\":[" + String.join(",", pending) + "],\"purged\":" + purged
                + ",\"cookieLeft\":" + cookieLeft + ",\"answer\":" + answer + "}";
    }

    private String answer(String line) {
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            reset();
            return "{\"state\":" + state() + "}";
        }
        String body = line.substring(event);
        Matcher type = TYPE.matcher(body);
        if (!type.find()) throw new IllegalArgumentException("an event without a type: " + line);
        boolean accepted = apply(type.group(1), body);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
    }

    public static void main(String[] args) throws Exception {
        ProfilePurgeReplay replay = new ProfilePurgeReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line = input.readLine(); line != null; line = input.readLine()) {
            String reply;
            try {
                reply = replay.answer(line);
            } catch (RuntimeException failure) {
                reply = "{\"error\":\"" + String.valueOf(failure.getMessage()).replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
            }
            System.out.println(reply);
            System.out.flush();
        }
    }
}
