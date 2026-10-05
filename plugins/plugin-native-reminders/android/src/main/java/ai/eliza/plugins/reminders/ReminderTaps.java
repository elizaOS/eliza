package ai.eliza.plugins.reminders;

import android.content.Context;
import java.util.*;
import org.json.*;

/** Exact local reminder navigation. Capturing a tap never authorizes an effect. */
final class ReminderTaps {
 static final class UnknownTap extends Exception {}
 private final Context context;
 private final SecureStringStore storage;
 private final ReminderStore owner;
 private final ReminderConfiguration configuration;
 ReminderTaps(Context context,ReminderStore owner) { this.context=context;this.owner=owner;this.configuration=owner.configuration;this.storage=owner.secure; }
 private JSONObject ledger() throws Exception {
  String raw = storage.read(configuration.tapSlot);
  JSONObject rows = raw == null ? new JSONObject() : new JSONObject(raw);
  if (rows.length() > 512) throw new IllegalStateException("Reminder tap capacity exceeded");
  Set<Long> orders = new HashSet<>();
  for (String token : keys(rows)) {
   JSONObject row = rows.getJSONObject(token);
   if (!token.matches("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}") || !keys(row).equals(Set.of("target", "state", "order")) || !Set.of("new", "pending", "consumed").contains(row.getString("state"))) throw new IllegalStateException("Invalid reminder tap ledger");
   target(row.getJSONObject("target"));
   Object rawOrder = row.get("order"); long order = row.getLong("order");
   if (!(rawOrder instanceof Integer || rawOrder instanceof Long) || order < 0 || order == 0 && !row.getString("state").equals("new") || order > 0 && !orders.add(order)) throw new IllegalStateException("Invalid reminder tap order");
  }
  return rows;
 }
 private static Set<String> keys(JSONObject value) { Set<String> result = new HashSet<>(); Iterator<String> it = value.keys(); while (it.hasNext()) result.add(it.next()); return result; }
 private static JSONObject target(JSONObject value) throws Exception {
  Set<String> fields = new HashSet<>(Set.of("sourceId", "sourceRevision", "reminderId", "occurrenceId", "revision"));
  if (value.has("timingVersion")) fields.add("timingVersion");
  if (!keys(value).equals(fields)) throw new IllegalStateException("Invalid reminder target");
  for (String key : fields) {
   if (key.equals("timingVersion")) { if (!Integer.valueOf(2).equals(value.get(key))) throw new IllegalStateException("Invalid reminder timing version"); }
   else if (!(value.get(key) instanceof String) || value.getString(key).isEmpty() || value.getString(key).length() > 128 || value.getString(key).indexOf('\0') >= 0) throw new IllegalStateException("Invalid reminder target");
  }
  if (!ReminderStore.validId(value.getString("reminderId")) || !value.getString("sourceRevision").matches("[a-f0-9]{64}") || !value.getString("revision").matches("[a-f0-9]{64}")) throw new IllegalStateException("Invalid reminder target");
  return new JSONObject(value.toString());
 }
 static boolean same(JSONObject a, JSONObject b) throws JSONException { if (!keys(a).equals(keys(b))) return false; for (String key : keys(a)) if (!a.get(key).equals(b.get(key))) return false; return true; }
 private boolean retained(JSONObject row) throws Exception {
  JSONObject target = row.getJSONObject("target");
  try { return same(target, owner.selected(context, target.getString("reminderId"))); }
  catch (IllegalArgumentException missing) { return false; }
 }
 private android.app.PendingIntent intent(String token) {
  android.content.Intent intent = new android.content.Intent(context, configuration.activityClass).setAction(configuration.openAction)
   .setData(android.net.Uri.parse(configuration.tapUriPrefix + token)).addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
  return android.app.PendingIntent.getActivity(context, 0, intent, android.app.PendingIntent.FLAG_NO_CREATE | android.app.PendingIntent.FLAG_IMMUTABLE);
 }
 private boolean posted(String token) {
  android.app.PendingIntent expected = intent(token);
  if (expected == null) return false;
  for (android.service.notification.StatusBarNotification notice : context.getSystemService(android.app.NotificationManager.class).getActiveNotifications())
   if (expected.equals(notice.getNotification().contentIntent)) return true;
  return false;
 }
 private void cancelExact(String token, JSONObject target) throws Exception {
  android.app.PendingIntent expected = intent(token);
  if (expected == null) return;
  android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
  for (android.service.notification.StatusBarNotification notice : manager.getActiveNotifications())
   if (notice.getId() == 0 && configuration.notificationTag(target.getString("reminderId")).equals(notice.getTag()) && expected.equals(notice.getNotification().contentIntent)) manager.cancel(notice.getTag(), notice.getId());
 }
 String prepare(JSONObject input) throws Exception { synchronized (owner) {
  JSONObject exact = target(input), rows = ledger();
  // In-flight identical publication reuses its identity. A deliberate later
  // publication after consumption receives a fresh token; old taps never revive.
  for (String token : keys(rows)) if (!rows.getJSONObject(token).getString("state").equals("consumed") && same(exact, rows.getJSONObject(token).getJSONObject("target"))) return token;
  // Only acknowledged routes whose exact OS notice is absent may be reclaimed.
  // Forgotten UUIDs resolve UnknownTap; never bind an old token to a newer record.
  for (String token : keys(rows)) if (rows.getJSONObject(token).getString("state").equals("consumed") && !posted(token)) rows.remove(token);
  if (rows.length() >= 512) throw new IllegalStateException("Reminder tap storage full");
  String token = UUID.randomUUID().toString();
  rows.put(token, new JSONObject().put("target", exact).put("state", "new").put("order", 0));
  storage.write(configuration.tapSlot, rows.toString()); return token;
 } }
 void capture(String token) throws Exception { synchronized (owner) {
  JSONObject rows = ledger(), row = rows.optJSONObject(token);
  if (row == null) throw new UnknownTap();
  // Retain even stale taps as an unavailable route: never redirect to a replacement occurrence.
  if (!row.getString("state").equals("consumed")) {
   long order = 0; for (String key : keys(rows)) order = Math.max(order, rows.getJSONObject(key).getLong("order"));
   row.put("state", "pending").put("order", Math.addExact(order, 1)); storage.write(configuration.tapSlot, rows.toString());
  }
 } }
 JSONObject pending() throws Exception { synchronized (owner) {
  JSONObject rows = ledger(), selected = null; String token = null; long order = -1;
  for (String key : keys(rows)) { JSONObject row = rows.getJSONObject(key); if (row.getString("state").equals("pending") && row.getLong("order") > order) { selected = row; token = key; order = row.getLong("order"); } }
  return selected == null ? new JSONObject() : new JSONObject().put("token", token).put("target", target(selected.getJSONObject("target"))).put("retained", retained(selected));
 } }
 JSONObject consume(String token) throws Exception { synchronized (owner) {
  JSONObject current = pending();
  if (token == null || !token.equals(current.optString("token")) || !current.getBoolean("retained")) throw new IllegalStateException("Reminder tap changed");
  JSONObject rows = ledger(); rows.getJSONObject(token).put("state", "consumed"); storage.write(configuration.tapSlot, rows.toString());
  cancelExact(token, current.getJSONObject("target"));
  return current.getJSONObject("target");
 } }
 void dismiss(String token) throws Exception { synchronized (owner) {
  JSONObject current = pending();
  if (token == null || !token.equals(current.optString("token"))) throw new IllegalStateException("Reminder tap changed");
  JSONObject rows = ledger(); rows.getJSONObject(token).put("state", "consumed"); storage.write(configuration.tapSlot, rows.toString());
  cancelExact(token, current.getJSONObject("target"));
 } }
}
