// spec/os/android/files/storageWatch.md, "Story: Watch a folder with one live observer"
package ai.eliza.files;

import ai.eliza.plugins.filesystem.browser.StorageBrowser;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class StorageWatchReplay {
    private static final Pattern TYPE = Pattern.compile("\"type\"\\s*:\\s*\"(\\w+)\"");
    private static final Pattern TICKET = Pattern.compile("\"ticket\"\\s*:\\s*(-?\\d+)");

    private StorageBrowser.WatchSlot slot = new StorageBrowser.WatchSlot();
    private final List<String> out = new ArrayList<>();

    private String state() {
        long watching = slot.watchedTicket(), refused = slot.refusedTicket();
        String held = watching > 0 ? "{\"tag\":\"Watching\",\"ticket\":" + watching + "}"
                : refused > 0 ? "{\"tag\":\"Refused\",\"ticket\":" + refused + "}"
                : "{\"tag\":\"Unwatched\"}";
        return "{\"generation\":" + slot.generation() + ",\"slot\":" + held + "}";
    }

    private StorageBrowser.WatchSlot.Watch watchFor(long ticket) {
        return () -> out.add("{\"tag\":\"StopWatch\",\"ticket\":" + ticket + "}");
    }

    private boolean apply(String type, long ticket) {
        switch (type) {
            case "request" -> slot.request();
            case "install" -> { return slot.install(ticket, () -> watchFor(ticket)); }
            case "refuse" -> { return slot.refuse(ticket); }
            case "unwatch" -> slot.unwatch();
            case "observe" -> { if (slot.observe(ticket)) out.add("{\"tag\":\"PublishChanged\"}"); }
            default -> throw new IllegalArgumentException("unknown event " + type);
        }
        return true;
    }

    private String answer(String line) {
        out.clear();
        int event = line.indexOf("\"event\"");
        if (event < 0) {
            slot = new StorageBrowser.WatchSlot();
            return "{\"state\":" + state() + ",\"out\":[]}";
        }
        String body = line.substring(event);
        Matcher type = TYPE.matcher(body);
        if (!type.find()) throw new IllegalArgumentException("an event without a type: " + line);
        Matcher ticket = TICKET.matcher(body);
        boolean accepted = apply(type.group(1), ticket.find() ? Long.parseLong(ticket.group(1)) : 0);
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + state()
                + ",\"out\":[" + String.join(",", out) + "]}";
    }

    public static void main(String[] args) throws Exception {
        StorageWatchReplay replay = new StorageWatchReplay();
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
