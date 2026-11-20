// spec/os/browser/chromium.md, "Story: Use the owned browser only with its expected identity"
package ai.eliza.plugins.browsersurface;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ChromiumBindingReplay {
    private static final long IDLE_MILLIS = 600_000;
    private static final Pattern TYPE = Pattern.compile("\"type\"\\s*:\\s*\"(\\w+)\"");
    private static final Pattern RESULT = Pattern.compile("\"result\"\\s*:\\s*\"(\\w+)\"");
    private static final Pattern HOLD = Pattern.compile("\"holdId\"\\s*:\\s*(-?\\d+)");
    private static final Pattern IDENTITY = Pattern.compile("\"identityMatches\"\\s*:\\s*(true|false)");
    private static final Field PINNED = field("pinned"), RETRY = field("retryMillis");

    private static Field field(String name) {
        try {
            Field field = ChromiumBindingDemand.class.getDeclaredField(name);
            field.setAccessible(true);
            return field;
        } catch (NoSuchFieldException missing) {
            throw new IllegalStateException("ChromiumBindingDemand has no field " + name, missing);
        }
    }

    private static final class Port implements ChromiumBindingDemand.Host {
        ChromiumBindingDemand.BindResult answer = ChromiumBindingDemand.BindResult.ACCEPTED;
        boolean refusedForGood;
        final Map<Runnable, Long> pending = new LinkedHashMap<>();

        @Override public ChromiumBindingDemand.BindResult bind() {
            refusedForGood = answer == ChromiumBindingDemand.BindResult.UNTRUSTED || answer == ChromiumBindingDemand.BindResult.DENIED;
            return answer;
        }
        @Override public void unbind() { }
        @Override public void schedule(Runnable task, long delayMillis) { pending.put(task, delayMillis); }
        @Override public void cancel(Runnable task) { pending.remove(task); }

        Runnable task(boolean idle) {
            for (Map.Entry<Runnable, Long> entry : pending.entrySet())
                if ((entry.getValue() == IDLE_MILLIS) == idle) return entry.getKey();
            return null;
        }

        void fire(boolean idle) {
            Runnable task = task(idle);
            pending.remove(task);
            task.run();
        }
    }

    private Port port = new Port();
    private ChromiumBindingDemand demand = new ChromiumBindingDemand(IDLE_MILLIS, port);
    private final Map<Integer, ChromiumBindingDemand.Hold> holds = new TreeMap<>();
    private final List<Integer> registered = new ArrayList<>();
    private final List<Integer> fired = new ArrayList<>();
    private final List<Integer> out = new ArrayList<>();

    private void reset() {
        port = new Port();
        demand = new ChromiumBindingDemand(IDLE_MILLIS, port);
        holds.clear();
        registered.clear();
        fired.clear();
    }

    private boolean pinned() {
        try {
            return !demand.isClosed() && PINNED.getBoolean(demand);
        } catch (IllegalAccessException denied) {
            throw new IllegalStateException(denied);
        }
    }

    private long backoff() {
        try {
            return RETRY.getLong(demand);
        } catch (IllegalAccessException denied) {
            throw new IllegalStateException(denied);
        }
    }

    private String link() {
        if (demand.isClosed()) return "Closed";
        if (demand.isReady()) return "Ready";
        if (demand.isBound()) return "Bound";
        if (port.task(false) != null) return "RetryScheduled";
        return port.refusedForGood ? "Unavailable" : "Unbound";
    }

    private boolean open(int id) {
        ChromiumBindingDemand.Hold hold = holds.get(id);
        return hold != null && hold.isOpen() && !demand.isClosed();
    }

    private List<Integer> openHolds() {
        return holds.keySet().stream().filter(this::open).toList();
    }

    private List<Integer> waiting() {
        List<Integer> waiting = registered.stream().filter(id -> open(id) && !fired.contains(id)).toList();
        if (waiting.size() != demand.waitingCallbacks())
            throw new IllegalStateException("the replay counts " + waiting.size() + " waiting callbacks, the demand " + demand.waitingCallbacks());
        return waiting;
    }

    private static String ints(List<Integer> ids) {
        return "[" + String.join(",", ids.stream().map(String::valueOf).toList()) + "]";
    }

    private String state() {
        return "{\"link\":\"" + link() + "\",\"backoffMs\":" + backoff() + ",\"pinned\":" + pinned()
                + ",\"nextHold\":" + (holds.size() + 1) + ",\"openHolds\":" + ints(openHolds())
                + ",\"waiting\":" + ints(waiting()) + ",\"fired\":" + ints(fired.stream().sorted().toList())
                + ",\"idlePending\":" + (port.task(true) != null) + "}";
    }

    private static ChromiumBindingDemand.BindResult result(String body) {
        Matcher result = RESULT.matcher(body);
        if (!result.find()) throw new IllegalArgumentException("an event without a bind result: " + body);
        return switch (result.group(1)) {
            case "BindAccepted" -> ChromiumBindingDemand.BindResult.ACCEPTED;
            case "BindRefused" -> ChromiumBindingDemand.BindResult.REFUSED;
            case "BindUntrusted" -> ChromiumBindingDemand.BindResult.UNTRUSTED;
            case "BindDenied" -> ChromiumBindingDemand.BindResult.DENIED;
            default -> throw new IllegalArgumentException("not a bind result: " + result.group(1));
        };
    }

    private static int hold(String body) {
        Matcher hold = HOLD.matcher(body);
        if (!hold.find()) throw new IllegalArgumentException("an event without a holdId: " + body);
        return Integer.parseInt(hold.group(1));
    }

    private boolean apply(String type, String body) {
        String link = link();
        switch (type) {
            case "pin" -> {
                if (demand.isClosed()) return false;
                port.answer = result(body);
                demand.pin();
            }
            case "unpin" -> {
                if (!pinned()) return false;
                demand.unpin();
            }
            case "acquireHold" -> {
                if (demand.isClosed()) return false;
                port.answer = result(body);
                holds.put(holds.size() + 1, demand.acquire());
            }
            case "releaseHold" -> {
                int id = hold(body);
                if (!open(id)) return false;
                holds.get(id).close();
            }
            case "registerReady" -> {
                int id = hold(body);
                if (!open(id) || registered.contains(id)) return false;
                registered.add(id);
                holds.get(id).whenReady(() -> {
                    fired.add(id);
                    out.add(id);
                });
            }
            case "connected" -> {
                if (!link.equals("Bound")) return false;
                Matcher identity = IDENTITY.matcher(body);
                if (!identity.find()) throw new IllegalArgumentException("connected without identityMatches: " + body);
                if (Boolean.parseBoolean(identity.group(1))) demand.connected();
                else demand.close();
            }
            case "disconnected" -> {
                if (!link.equals("Ready")) return false;
                demand.disconnected();
            }
            case "lostBinding" -> {
                if (!link.equals("Bound") && !link.equals("Ready")) return false;
                demand.bindingLost();
            }
            case "retryFires" -> {
                if (!link.equals("RetryScheduled")) return false;
                port.answer = result(body);
                port.fire(false);
            }
            case "idleRelease" -> {
                if (port.task(true) == null) return false;
                port.fire(true);
                port.refusedForGood = false;
            }
            case "close" -> {
                if (demand.isClosed()) return false;
                demand.close();
            }
            default -> throw new IllegalArgumentException("unknown event " + type);
        }
        return true;
    }

    private String answer(String line) {
        out.clear();
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            reset();
            return "{\"state\":" + state() + ",\"out\":[]}";
        }
        String body = line.substring(event);
        Matcher type = TYPE.matcher(body);
        if (!type.find()) throw new IllegalArgumentException("an event without a type: " + line);
        boolean accepted = apply(type.group(1), body);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state() + ",\"out\":" + ints(out) + "}";
    }

    public static void main(String[] args) throws Exception {
        ChromiumBindingReplay replay = new ChromiumBindingReplay();
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
