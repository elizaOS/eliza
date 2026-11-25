// spec/cloud/services/google/mailRead.md, "Story: Hear about new mail while my phone is idle"
package ai.eliza.plugins.notifications;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, manifest = Config.NONE)
public final class MailBackgroundDeliveryTest {
  static void require(boolean condition, String step) {
    if (!condition) throw new AssertionError(step);
  }

  @Test public void noticesFollowTheExactLease() throws Exception {
    final class Fixture implements MailBackgroundDelivery.LocalState, MailBackgroundDelivery.LeaseAccess,
      MailBackgroundDelivery.Scheduler, MailBackgroundDelivery.Notices {
      final Object fence = new Object();
      final List<String> routes = new ArrayList<>();
      final HashSet<String> active = new HashSet<>();
      MailBackgroundDelivery.LeaseBinding binding = new MailBackgroundDelivery.LeaseBinding("cred", "a".repeat(64), "owner", "org");
      String state;
      String scheduled;
      boolean rotate;
      boolean inForeground = true;
      boolean loseForeground;
      @Override public Object lock() { return fence; }
      @Override public String readState() { return state; }
      @Override public void writeState(String value) { require(Thread.holdsLock(fence), "atomic state write"); state = value; }
      @Override public void removeState() { require(Thread.holdsLock(fence), "atomic withdrawal"); state = null; }
      @Override public boolean resetPending() { return false; }
      @Override public MailBackgroundDelivery.LeaseBinding current() { require(Thread.holdsLock(fence), "read under credential fence"); return binding; }
      @Override public MailBackgroundDelivery.LeaseReply read(MailBackgroundDelivery.LeaseBinding expected, String path) throws Exception {
        require(!Thread.holdsLock(fence) && expected.equals(binding), "leased network read outside fence");
        routes.add(path);
        final String encoded;
        if (path.equals("/api/v1/eliza/google/accounts?side=owner")) {
          encoded = new JSONArray().put(new JSONObject().put("connectionId", "grant").put("connected", true)
            .put("grantedCapabilities", new JSONArray().put("google.gmail.triage"))).toString();
          if (loseForeground) inForeground = false;
        } else {
          require(path.startsWith("/api/v1/eliza/google/gmail/inbox-v1/history?grantId=grant&maxResults=50"), "leased history route");
          boolean baseline = !path.contains("startHistoryId=");
          JSONObject page = new JSONObject().put("version", 1).put("grantId", "grant")
            .put("status", baseline ? "baseline-required" : "page").put("backfillRequired", baseline)
            .put("historyId", baseline ? "100" : "101").put("startHistoryId", baseline ? JSONObject.NULL : "100")
            .put("checkpoint", baseline ? JSONObject.NULL : "101").put("nextPageToken", JSONObject.NULL);
          JSONArray events = new JSONArray();
          if (!baseline) events.put(new JSONObject().put("id", "101:message-added:message")
            .put("historyId", "101").put("type", "message-added").put("messageId", "message").put("threadId", "conversation")
            .put("messageAvailable", true).put("labelIds", new JSONArray().put("INBOX").put("UNREAD")));
          encoded = page.put("events", events).toString();
          if (rotate) binding = new MailBackgroundDelivery.LeaseBinding("cred", "b".repeat(64), "owner", "org");
        }
        return new MailBackgroundDelivery.LeaseReply(200, encoded.getBytes(StandardCharsets.UTF_8));
      }
      @Override public void schedule(String generation) { scheduled = generation; }
      @Override public boolean allowed() { return true; }
      @Override public boolean active(String key) { return active.contains(key); }
      @Override public void post(String key) { require(Thread.holdsLock(fence), "post under credential fence"); active.add(key); }
      @Override public void cancel(String key) { active.remove(key); }
      @Override public void cancel() { scheduled = null; }
      @Override public void cancelAll() { active.clear(); }
    }
    Fixture f = new Fixture();
    var config = new MailBackgroundDelivery.Config("https://cloud.example", "test", "google.gmail.triage", 1);
    var delivery = MailBackgroundDelivery.withLease(f, f, f, f, config);
    f.active.add("retired");
    f.scheduled = "retired";
    delivery.resume();
    require(f.active.isEmpty() && f.scheduled == null, "a notice without an admitted watch is retired");
    f.loseForeground = true;
    try {
      delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org", () -> {
        if (!f.inForeground) throw new SecurityException("Visit changed");
      });
      throw new AssertionError("Background selection accepted");
    } catch (SecurityException expected) {
      require(f.state == null && f.scheduled == null, "a late foreground check created no watch");
    }
    f.loseForeground = false;
    delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org");
    require(delivery.sync(f.scheduled, () -> {}), "baseline sync completed");
    require(f.active.isEmpty(), "quiet baseline");
    require(delivery.sync(f.scheduled, () -> {}), "arrival sync completed");
    require(f.active.size() == 1, "one exact notice");
    delivery.capture(f.active.iterator().next(), true);
    var tap = delivery.pending(() -> {});
    require(tap.getBoolean("question") && tap.getString("messageId").equals("message"), "exact Ask tap");
    f.rotate = true;
    String state = f.state;
    try {
      delivery.sync(f.scheduled, () -> {});
      throw new AssertionError("stale credential accepted");
    } catch (SecurityException expected) {
      require(state.equals(f.state), "late reply did not alter durable state");
    }
    require(delivery.status().getString("status").equals("disabled"), "a rotated watch is shown as off");
    require(f.active.isEmpty() && f.state == null && f.scheduled == null, "status retires stale notices and work before resume");
    long renewed = delivery.begin("grant");
    delivery.resume();
    delivery.configure(renewed, "cred", "grant", "owner", "org");
    require(f.scheduled != null && f.active.isEmpty(), "resume leaves a newer foreground selection in place");
    require(f.routes.stream().noneMatch(path -> path.contains("/user")), "no raw device key route");
  }
}
