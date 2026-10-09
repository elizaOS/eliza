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
            .put("source", "native-transport-test").put("createdAt", System.currentTimeMillis())
            .put("nativeEpoch", "10000000-0000-0000-0000-000000000001").put("nativeSequence", 1);
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
        try { NativeNotificationWire.notification("{"); } catch (org.json.JSONException invalid) { malformed = true; }
        check(malformed, "Malformed live frame must be rejected at the input boundary");
        frame.put("type", "agent_event").put("stream", "notification");
        frame.getJSONObject("payload").put("type", "notification");
        frame.getJSONObject("payload").getJSONObject("notification").put("category", "future_unsupported");
        boolean unsupported = false;
        try { NativeNotificationWire.notification(frame.toString()); } catch (IllegalArgumentException invalid) { unsupported = true; }
        check(unsupported, "Unknown category must reject only its live input");
        frame.getJSONObject("payload").getJSONObject("notification").put("category", "agent");
        check(NativeNotificationWire.notification(frame.toString()) != null, "A valid next event remains independently readable");
        for (String state : new String[]{"connected", "connecting", "disconnected"}) {
            check(NativeNotificationState.enabled(state, true, true, true, true), "Healthy active ownership unavailable");
            check(!NativeNotificationState.enabled(state, true, true, true, false), "First online activation must be complete before delivery is enabled");
            check(!NativeNotificationState.enabled(state, false, true, true, true), "Retired preference still owns presentation");
            check(!NativeNotificationState.enabled(state, true, false, true, true), "Different profile still owns presentation");
            check(!NativeNotificationState.enabled(state, true, true, false, true), "Denied notifications still own presentation");
        }
        for (String state : new String[]{"stopped", "owner_changed", "authorization_rejected", "start_denied", "resume_unavailable", "retirement_unavailable", "unavailable", "startup_unavailable", "inbox_unavailable", "delivery_unavailable", "event_backlog"})
            check(!NativeNotificationState.enabled(state, true, true, true, true), "Failure state claimed enabled: " + state);
        JSONObject cursor = new JSONObject().put("afterSequence", 0);
        check(NativeNotificationWire.pagePath(cursor).equals("/api/notifications?nativeTransport=true&afterSequence=0&limit=128"), "Closed initial query");
        cursor.put("nativeEpoch", "10000000-0000-0000-0000-000000000001").put("afterSequence", 1).put("throughSequence", 20);
        check(NativeNotificationWire.pagePath(cursor).endsWith("&throughSequence=20&limit=128"), "Fixed continuation fence");
        boolean rejected = false;
        try { NativeNotificationWire.pagePath(new JSONObject().put("afterSequence", 1)); } catch (IllegalArgumentException invalid) { rejected = true; }
        check(rejected, "Continuation requires epoch");
        rejected = false;
        try { NativeNotificationWire.pagePath(new JSONObject().put("afterSequence", 0).put("nativeEpoch", "../?token=secret")); } catch (IllegalArgumentException invalid) { rejected = true; }
        check(rejected, "Query builder rejects path/auth expansion");
        frame.getJSONObject("payload").put("nativeNotification", record().put("title", "Bounded projection"));
        check(NativeNotificationWire.notification(frame.toString()).getString("title").equals("Bounded projection"), "Native projection wins over arbitrary standard fields");
        frame.getJSONObject("payload").put("nativeProjectionError", "oversized");
        rejected = false;
        try { NativeNotificationWire.notification(frame.toString()); } catch (IllegalArgumentException invalid) { rejected = true; }
        check(rejected, "Explicit projection failure rejects only live input");
        System.out.println("Native notification wire/state checks passed: " + checks);
    }
}
