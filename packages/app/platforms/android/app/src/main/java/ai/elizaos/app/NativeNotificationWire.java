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
        if (payload.has("nativeProjectionError")) throw new IllegalArgumentException("Native notification projection unavailable");
        return NativeNotificationInbox.checked(payload.has("nativeNotification")
            ? payload.getJSONObject("nativeNotification") : payload.getJSONObject("notification"));
    }
    static long sequence(JSONObject object, String field, boolean zero) throws Exception {
        Object raw = object.get(field);
        if (!(raw instanceof Number)) throw new IllegalArgumentException("Invalid notification sequence");
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value) || value != Math.rint(value) || value < (zero ? 0 : 1) || value > 9007199254740991L)
            throw new IllegalArgumentException("Invalid notification sequence");
        return ((Number) raw).longValue();
    }

    static String pagePath(JSONObject cursor) throws Exception {
        for (java.util.Iterator<String> keys = cursor.keys(); keys.hasNext();) {
            if (!java.util.Arrays.asList("afterSequence", "nativeEpoch", "throughSequence").contains(keys.next()))
                throw new IllegalArgumentException("Notification query field unavailable");
        }
        long after = sequence(cursor, "afterSequence", true);
        StringBuilder path = new StringBuilder("/api/notifications?nativeTransport=true&afterSequence=").append(after);
        if (cursor.has("nativeEpoch")) {
            String epoch = cursor.getString("nativeEpoch");
            if (!epoch.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")) throw new IllegalArgumentException("Invalid notification page epoch");
            path.append("&nativeEpoch=").append(epoch);
        } else if (after != 0 || cursor.has("throughSequence")) throw new IllegalArgumentException("Notification continuation epoch required");
        if (cursor.has("throughSequence")) {
            long through = sequence(cursor, "throughSequence", true);
            if (through < after) throw new IllegalArgumentException("Invalid notification page range");
            path.append("&throughSequence=").append(through);
        }
        return path.append("&limit=128").toString();
    }

    static JSONObject page(JSONObject input, JSONObject cursor) throws Exception {
        pagePath(cursor);
        // The HTTP reader already rejects a raw body over 256 KiB. Measuring
        // JSONObject.toString() again is wrong: Android's JSONStringer writes
        // "/" as "\/", so a page of links that fit the server budget fails
        // here and the cursor never advances.
        JSONObject page = new JSONObject(input.toString());
        if (!"ready".equals(page.getString("serviceStatus"))) throw new IllegalArgumentException("Notification service is not ready");
        String epoch = page.getString("nativeEpoch");
        if (!epoch.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            || (cursor.has("nativeEpoch") && !epoch.equals(cursor.getString("nativeEpoch")))) throw new IllegalArgumentException("Notification page epoch changed");
        long after = sequence(cursor, "afterSequence", true), through = sequence(page, "throughSequence", true), next = sequence(page, "nextSequence", true);
        if (through < after || next < after || next > through || (cursor.has("throughSequence") && through != cursor.getLong("throughSequence"))) throw new IllegalArgumentException("Notification page fence changed");
        if (!(page.get("complete") instanceof Boolean)) throw new IllegalArgumentException("Invalid notification page completion");
        boolean complete = page.getBoolean("complete");
        org.json.JSONArray records = page.getJSONArray("notifications");
        if (records.length() > 128) throw new IllegalArgumentException("Notification page count exceeded");
        long last = after;
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < records.length(); i++) {
            JSONObject record = NativeNotificationInbox.checked(records.getJSONObject(i));
            long sequence = record.getLong("nativeSequence");
            if (!epoch.equals(record.getString("nativeEpoch")) || sequence <= last || sequence > through || !ids.add(record.getString("id"))) throw new IllegalArgumentException("Notification page order changed");
            last = sequence; records.put(i, record);
        }
        if (complete ? next != through : records.length() == 0 || next != last || next >= through)
            throw new IllegalArgumentException("Invalid notification page progress");
        return page;
    }
}
