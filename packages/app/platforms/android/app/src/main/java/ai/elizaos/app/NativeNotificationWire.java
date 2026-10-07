package ai.elizaos.app;

import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** The existing dashboard event protocol, not the separate Gateway RPC protocol. */
final class NativeNotificationWire {
    static JSONObject notification(String frame) throws Exception {
        if (frame.getBytes(StandardCharsets.UTF_8).length > 4 * 1024 * 1024)
            throw new IllegalArgumentException("Native notification frame too large");
        JSONObject event = new JSONObject(frame);
        if (!"agent_event".equals(event.optString("type")) || !"notification".equals(event.optString("stream"))) return null;
        JSONObject payload = event.getJSONObject("payload");
        // NotificationService.broadcast's canonical new-record event is
        // "notification". Updates/read acknowledgements never alert again.
        if (!"notification".equals(payload.optString("type"))) return null;
        return NativeNotificationInbox.checked(payload.getJSONObject("notification"));
    }
}
