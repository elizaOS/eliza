package ai.elizaos.app;

import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;

/** Executes the production wire/state policies against the actual producer
 * enum and dashboard event shape. No foreground-service simulation. */
public final class NativeNotificationTransportTest {
    private static int checks;
    private static void check(boolean value, String reason) {
        if (!value) throw new AssertionError(reason);
        checks++;
    }
    private static JSONObject record() throws Exception {
        return new JSONObject().put("id", "ee26d7a4-9d71-4051-a117-906626d91424")
            .put("title", "Agent update").put("body", "Ready")
            .put("category", "agent").put("priority", "normal")
            .put("source", "native-transport-test").put("createdAt", System.currentTimeMillis());
    }
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]);
        String producer = Files.readString(root.resolve("packages/core/src/services/notification.ts"));
        check(java.util.regex.Pattern.compile("type:\\s*NotificationEventData\\[\"type\"\\]\\s*=\\s*\"notification\"").matcher(producer).find(), "Production notification producer enum changed");
        String server = Files.readString(root.resolve("packages/agent/src/api/server.ts"));
        check(server.contains("type: \"agent_event\"") && server.contains("stream: event.stream") && server.contains("payload: event.data"), "Production dashboard envelope changed");
        JSONObject frame = new JSONObject().put("type", "agent_event").put("stream", "notification")
            .put("payload", new JSONObject().put("type", "notification").put("notification", record()).put("unreadCount", 1));
        check(NativeNotificationWire.notification(frame.toString()).getString("category").equals("agent"), "Actual producer wire must deliver");
        frame.getJSONObject("payload").put("type", "notification_update");
        check(NativeNotificationWire.notification(frame.toString()) == null, "Read/update must not alert again");
        frame.getJSONObject("payload").put("type", "notification_new");
        check(NativeNotificationWire.notification(frame.toString()) == null, "Invented legacy enum must not replace canonical producer");
        frame.put("stream", "logs");
        check(NativeNotificationWire.notification(frame.toString()) == null, "Other event streams are not notifications");
        frame.put("type", "heartbeat_event");
        check(NativeNotificationWire.notification(frame.toString()) == null, "Heartbeat is not a new notification");
        boolean malformed = false;
        try { NativeNotificationWire.notification("{"); } catch (Exception invalid) { malformed = true; }
        check(malformed, "Malformed frame cannot fabricate an empty successful inbox");
        for (String state : new String[]{"connected", "connecting", "disconnected"}) {
            check(NativeNotificationState.enabled(state, true, true, true, true), "Healthy active ownership unavailable");
            check(!NativeNotificationState.enabled(state, true, true, true, false), "First online activation must be complete before delivery is enabled");
            check(!NativeNotificationState.enabled(state, false, true, true, true), "Retired preference still owns presentation");
            check(!NativeNotificationState.enabled(state, true, false, true, true), "Different profile still owns presentation");
            check(!NativeNotificationState.enabled(state, true, true, false, true), "Denied notifications still own presentation");
        }
        for (String state : new String[]{"stopped", "owner_changed", "authorization_rejected", "start_denied", "resume_unavailable", "retirement_unavailable", "unavailable", "startup_unavailable", "inbox_unavailable", "delivery_unavailable", "event_backlog"})
            check(!NativeNotificationState.enabled(state, true, true, true, true), "Failure state claimed enabled: " + state);
        System.out.println("Native notification wire/state checks passed: " + checks);
    }
}
