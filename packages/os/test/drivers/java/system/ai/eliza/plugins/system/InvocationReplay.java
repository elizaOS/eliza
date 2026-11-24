// spec/os/voice/invocation.md, "Story: Start voice from a trusted gesture, once"
package ai.eliza.plugins.system;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class InvocationReplay {
    private static final String HOST = "test.host";
    private static final String BINDING = "00000000-0000-4000-8000-000000000001";
    private static final long BRIDGE = 1;
    private static final int GENERATION = 1;

    private SenseInvocation invocation = new SenseInvocation();
    private long now = 1_000_000;
    private long account;
    private String answer = "{\"tag\":\"NoAnswer\"}";

    private static Matcher field(String body, String name, String value) {
        Matcher found = Pattern.compile("\"" + name + "\"\\s*:\\s*" + value).matcher(body);
        if (!found.find()) throw new IllegalArgumentException("an event without " + name + ": " + body);
        return found;
    }

    private static String text(String body, String name) { return field(body, name, "\"(\\w+)\"").group(1); }
    private static boolean flag(String body, String name) { return Boolean.parseBoolean(field(body, name, "(true|false)").group(1)); }
    private static long number(String body, String name) { return Long.parseLong(field(body, name, "(-?\\d+)").group(1)); }

    private static String session(long value) { return String.format("%064x", value); }

    private Object read(String name) {
        try {
            Field held = SenseInvocation.class.getDeclaredField(name);
            held.setAccessible(true);
            return held.get(invocation);
        } catch (ReflectiveOperationException missing) {
            throw new IllegalStateException(missing);
        }
    }

    private String bound() { return (String) read("session"); }

    private boolean arrive(String caller, boolean locked) {
        if (caller.equals("PowerActivity")) return invocation.recordProtectedPower(BRIDGE, now, locked);
        String callerPackage = switch (caller) {
            case "SenseListener" -> HOST + ".sense";
            case "SystemUi" -> "com.android.systemui";
            case "OtherApp" -> "test.other";
            default -> throw new IllegalArgumentException("unknown caller " + caller);
        };
        invocation.record(HOST, callerPackage, caller.equals("SenseListener"), caller.equals("SystemUi"), now, locked);
        return true;
    }

    private boolean take(long expected, boolean locked) {
        String origin = invocation.take(BRIDGE, GENERATION, BINDING, session(expected), now, locked);
        if (origin == null) return false;
        answer = origin.equals(SenseInvocation.ASSIST) ? "{\"tag\":\"OpenOnly\"}" : "{\"tag\":\"VoiceStart\",\"origin\":\"" + origin(origin) + "\"}";
        return true;
    }

    private boolean apply(String type, String body) {
        return switch (type) {
            case "bind" -> {
                long next = number(body, "session");
                if (next <= 0 || session(next).equals(bound())) yield false;
                invocation.bind(BRIDGE, GENERATION, BINDING, session(next), now);
                yield true;
            }
            case "unbind" -> {
                if (bound() == null) yield false;
                invocation.bind(BRIDGE, GENERATION, BINDING, null, now);
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
            case "observeListener" -> invocation.observeListener(text(body, "admission").equals("ListenerAdmitted"));
            case "admitOwner" -> {
                long next = number(body, "account");
                if (next <= 0 || next == account) yield false;
                account = next;
                invocation.admit(() -> "owner-" + next);
                yield true;
            }
            case "withdrawOwner" -> {
                if (account == 0) yield false;
                account = 0;
                invocation.admit(null);
                yield true;
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        };
    }

    private static String origin(String origin) {
        return switch (origin) {
            case SenseInvocation.LISTENER -> "Listener";
            case SenseInvocation.SYSTEM -> "System";
            case SenseInvocation.POWER -> "Power";
            default -> "Assist";
        };
    }

    private static long sessionNumber(String hex) { return Long.parseLong(hex, 16); }

    private String pending() {
        String origin = (String) read("origin");
        String arrivedFor = (String) read("invocationSession");
        String coldOwner = (String) read("coldOwner");
        if (origin == null || arrivedFor == null && coldOwner == null) return "{\"tag\":\"NoArrival\"}";
        String shown = (Boolean) read("locked") ? "Assist" : origin(origin);
        long age = now - (Long) read("arrivedAt");
        String common = "\"origin\":\"" + shown + "\",\"age\":" + age;
        if (arrivedFor == null) return "{\"tag\":\"Cold\"," + common + ",\"account\":" + coldOwner.substring("owner-".length()) + "}";
        if ((Boolean) read("adopted")) return "{\"tag\":\"Adopted\"," + common + ",\"session\":" + sessionNumber(arrivedFor) + ",\"account\":" + coldOwner.substring("owner-".length()) + "}";
        return "{\"tag\":\"Warm\"," + common + ",\"session\":" + sessionNumber(arrivedFor) + "}";
    }

    private String state() {
        String held = bound();
        return "{\"binding\":" + (held == null ? "{\"tag\":\"Unbound\"}" : "{\"tag\":\"Bound\",\"session\":" + sessionNumber(held) + "}")
                + ",\"owner\":" + (account == 0 ? "{\"tag\":\"NoOwner\"}" : "{\"tag\":\"AdmittedOwner\",\"account\":" + account + "}")
                + ",\"listenerAdmission\":\"" + ((Boolean) read("listenerAdmitted") ? "ListenerAdmitted" : "ListenerUnavailable") + "\""
                + ",\"pending\":" + pending() + ",\"answer\":" + answer + "}";
    }

    private String answer(String line) {
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            invocation = new SenseInvocation();
            now = 1_000_000;
            account = 0;
            answer = "{\"tag\":\"NoAnswer\"}";
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
