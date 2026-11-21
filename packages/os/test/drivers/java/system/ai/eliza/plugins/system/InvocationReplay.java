// spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"
package ai.eliza.plugins.system;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class InvocationReplay {
    private static final String HOST = "org.example.os";
    private static final String SYSTEM_UI = "com.android.systemui";
    private static final String BINDING = "00000000-0000-4000-8000-000000000001";
    private static final long BRIDGE = 1;
    private static final long BOOT = 1_000_000;

    private SenseInvocation invocation;
    private final Map<Long, Integer> generations = new HashMap<>();
    private int generation;
    private long now;
    private long owner;
    private boolean listenerAdmitted;
    private long arrivals;
    private long lastVoiceArrival;
    private String answer;

    private InvocationReplay() { reset(); }

    private void reset() {
        invocation = new SenseInvocation();
        invocation.admit(() -> owner > 0 ? "owner-" + owner : null);
        generations.clear();
        generation = 0;
        now = BOOT;
        owner = 0;
        listenerAdmitted = false;
        arrivals = 0;
        lastVoiceArrival = 0;
        answer = "{\"tag\":\"NoAnswer\"}";
    }

    private static Matcher field(String body, String name, String value) {
        Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
        if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
        return found;
    }

    private static String text(String body, String name) { return field(body, name, "\"(\\w+)\"").group(1); }
    private static boolean flag(String body, String name) { return Boolean.parseBoolean(field(body, name, "(true|false)").group(1)); }
    private static long number(String body, String name) { return Long.parseLong(field(body, name, "(-?\\d+)").group(1)); }

    private Object read(String name) {
        try {
            Field held = SenseInvocation.class.getDeclaredField(name);
            held.setAccessible(true);
            return held.get(invocation);
        } catch (ReflectiveOperationException missing) {
            throw new IllegalStateException("SenseInvocation has no field " + name, missing);
        }
    }

    private static String sessionKey(long session) { return String.format("%064x", session); }
    private static long session(String key) { return Long.parseLong(key, 16); }
    private static long account(String owner) { return Long.parseLong(owner.substring("owner-".length())); }

    private static String origin(String origin, boolean locked) {
        if (locked) return "Assist";
        return switch (origin) {
            case SenseInvocation.LISTENER -> "Listener";
            case SenseInvocation.SYSTEM -> "System";
            case SenseInvocation.POWER -> "Power";
            case SenseInvocation.ASSIST -> "Assist";
            default -> throw new IllegalStateException("unknown origin " + origin);
        };
    }

    private long age() { return now - (long) read("arrivedAt"); }

    private String pending() {
        String origin = (String) read("origin");
        if (origin == null) return "{\"tag\":\"NoArrival\"}";
        String waiting = (String) read("invocationSession");
        String coldOwner = (String) read("coldOwner");
        String shown = "\"origin\":\"" + origin(origin, (boolean) read("locked")) + "\",\"arrival\":" + arrivals + ",\"age\":" + age();
        if (waiting == null) return coldOwner == null ? "{\"tag\":\"NoArrival\"}" : "{\"tag\":\"Cold\"," + shown + ",\"account\":" + account(coldOwner) + "}";
        if ((boolean) read("adopted")) return "{\"tag\":\"Adopted\"," + shown + ",\"session\":" + session(waiting) + ",\"account\":" + account(coldOwner) + "}";
        return "{\"tag\":\"Warm\"," + shown + ",\"session\":" + session(waiting) + "}";
    }

    private String state() {
        String bound = (String) read("session");
        return "{\"binding\":" + (bound == null ? "{\"tag\":\"Unbound\"}" : "{\"tag\":\"Bound\",\"session\":" + session(bound) + "}")
                + ",\"owner\":" + (owner > 0 ? "{\"tag\":\"AdmittedOwner\",\"account\":" + owner + "}" : "{\"tag\":\"NoOwner\"}")
                + ",\"listenerAdmission\":\"" + (listenerAdmitted ? "ListenerAdmitted" : "ListenerUnavailable") + "\""
                + ",\"pending\":" + pending() + ",\"arrivals\":" + arrivals + ",\"lastVoiceArrival\":" + lastVoiceArrival + ",\"answer\":" + answer + "}";
    }

    private boolean bind(long next) {
        if (next <= 0) return false;
        String bound = (String) read("session");
        boolean rebinding = bound != null && session(bound) == next;
        if (!rebinding) generations.put(next, ++generation);
        String before = state();
        invocation.bind(BRIDGE, generations.get(next), BINDING, sessionKey(next), now);
        return !state().equals(before);
    }

    private boolean take(long expected, boolean locked) {
        boolean adopted = (boolean) read("adopted");
        long age = age();
        String taken = invocation.take(BRIDGE, generations.getOrDefault(expected, 0), BINDING, sessionKey(expected), now, locked);
        if (taken == null) return false;
        if (SenseInvocation.ASSIST.equals(taken)) {
            answer = "{\"tag\":\"OpenOnly\",\"arrival\":" + arrivals + "}";
        } else {
            answer = "{\"tag\":\"VoiceStart\",\"origin\":\"" + origin(taken, false) + "\",\"arrival\":" + arrivals + ",\"claim\":\""
                    + (adopted ? "AdoptedClaim" : "WarmClaim") + "\",\"age\":" + age + "}";
            lastVoiceArrival = arrivals;
        }
        return true;
    }

    private boolean arrive(String caller, boolean locked) {
        switch (caller) {
            case "SenseListener" -> invocation.record(HOST, HOST + ".sense", listenerAdmitted, false, now, locked);
            case "SystemUi" -> invocation.record(HOST, SYSTEM_UI, false, true, now, locked);
            case "OtherApp" -> invocation.record(HOST, "org.example.other", false, false, now, locked);
            case "PowerActivity" -> { if (!invocation.recordProtectedPower(BRIDGE, now, locked)) return false; }
            default -> throw new IllegalArgumentException("unknown caller " + caller);
        }
        arrivals += 1;
        return true;
    }

    private boolean apply(String type, String body) {
        return switch (type) {
            case "bind" -> bind(number(body, "session"));
            case "unbind" -> {
                if (read("session") == null) yield false;
                invocation.bind(BRIDGE, generation, BINDING, null, now);
                yield true;
            }
            case "elapse" -> {
                long ms = number(body, "ms");
                if (ms <= 0) yield false;
                now += ms;
                yield true;
            }
            case "take" -> take(number(body, "session"), flag(body, "locked"));
            case "arrive" -> arrive(text(body, "caller"), flag(body, "locked"));
            case "observeListener" -> {
                boolean admitted = "ListenerAdmitted".equals(text(body, "admission"));
                if (admitted == listenerAdmitted) yield false;
                listenerAdmitted = admitted;
                yield true;
            }
            case "admitOwner" -> {
                long account = number(body, "account");
                if (account <= 0 || account == owner) yield false;
                owner = account;
                yield true;
            }
            case "withdrawOwner" -> {
                if (owner == 0) yield false;
                owner = 0;
                yield true;
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        };
    }

    private String answer(String line) {
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            reset();
            return "{\"state\":" + state() + "}";
        }
        String body = line.substring(event);
        boolean accepted = apply(text(body, "type"), body);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + "}";
    }

    public static void main(String[] args) throws Exception {
        InvocationReplay replay = new InvocationReplay();
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
