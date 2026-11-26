// spec/cloud/services/google/mailRead.md, "Story: Hear about new mail while my phone is idle"; spec/os/signIn/cloudRequests.md, "A mail or calendar route is sent only with the lease, never with the device key"
package ai.eliza.plugins.notifications;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MailBackgroundDeliveryTest {
  private static final String ACCOUNTS = "/api/v1/eliza/google/accounts?side=owner";
  private static final String LEASED_HISTORY = "/api/v1/eliza/google/gmail/inbox-v1/history?grantId=grant&maxResults=50";
  private static final String FIRST = "a".repeat(64);
  private static final String ROTATED = "b".repeat(64);
  private static int checks;

  private interface Failing {
    void run() throws Exception;
  }

  private static void check(boolean value, String label) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks + ": " + label);
  }

  private static void refused(Failing action, String label) throws Exception {
    checks++;
    try {
      action.run();
    } catch (SecurityException expected) {
      return;
    }
    throw new AssertionError("Check " + checks + " should have been refused: " + label);
  }

  /** The host's state slot, lease custody, scheduler and shade, with the fences the module must hold recorded. */
  static final class Fixture implements MailBackgroundDelivery.LocalState, MailBackgroundDelivery.LeaseAccess,
      MailBackgroundDelivery.Scheduler, MailBackgroundDelivery.Notices {
    final Object fence = new Object();
    final List<String> routes = new ArrayList<>();
    final Set<String> active = new HashSet<>();
    final List<String> fenceBreaches = new ArrayList<>();
    MailBackgroundDelivery.LeaseBinding binding = lease(FIRST);
    String state;
    String scheduled;
    boolean reset;
    boolean inForeground = true;
    boolean loseForegroundOnAccounts;
    boolean rotateOnHistory;
    int historyStatus = 200;
    byte[] historyBody;

    static MailBackgroundDelivery.LeaseBinding lease(String fingerprint) {
      return new MailBackgroundDelivery.LeaseBinding("cred", fingerprint, "owner", "org");
    }

    private void fenced(boolean held, String what) {
      if (Thread.holdsLock(fence) != held) fenceBreaches.add(what);
    }

    @Override public Object lock() { return fence; }
    @Override public String readState() { return state; }
    @Override public void writeState(String value) { fenced(true, "state write"); state = value; }
    @Override public void removeState() { fenced(true, "withdrawal"); state = null; }
    @Override public boolean resetPending() { return reset; }
    @Override public MailBackgroundDelivery.LeaseBinding current() { fenced(true, "lease read"); return binding; }

    @Override public MailBackgroundDelivery.LeaseReply read(MailBackgroundDelivery.LeaseBinding expected, String path) throws Exception {
      fenced(false, "network read");
      if (!expected.equals(binding)) fenceBreaches.add("read with a lease that is not current");
      routes.add(path);
      if (path.equals(ACCOUNTS)) {
        if (loseForegroundOnAccounts) inForeground = false;
        return reply(200, accounts());
      }
      String page = history(path).toString();
      if (rotateOnHistory) binding = lease(ROTATED);
      return historyBody != null ? new MailBackgroundDelivery.LeaseReply(historyStatus, historyBody) : reply(historyStatus, page);
    }

    private static MailBackgroundDelivery.LeaseReply reply(int status, String body) {
      return new MailBackgroundDelivery.LeaseReply(status, body.getBytes(StandardCharsets.UTF_8));
    }

    private static String accounts() throws Exception {
      return new JSONArray().put(new JSONObject().put("connectionId", "grant").put("connected", true)
          .put("grantedCapabilities", new JSONArray().put("google.gmail.triage"))).toString();
    }

    private static JSONObject history(String path) throws Exception {
      boolean baseline = !path.contains("startHistoryId=");
      JSONObject page = new JSONObject().put("version", 1).put("grantId", "grant")
          .put("status", baseline ? "baseline-required" : "page").put("backfillRequired", baseline)
          .put("historyId", baseline ? "100" : "101").put("startHistoryId", baseline ? JSONObject.NULL : "100")
          .put("checkpoint", baseline ? JSONObject.NULL : "101").put("nextPageToken", JSONObject.NULL);
      JSONArray events = new JSONArray();
      if (!baseline) events.put(new JSONObject().put("id", "101:message-added:message").put("historyId", "101")
          .put("type", "message-added").put("messageId", "message").put("threadId", "conversation")
          .put("messageAvailable", true).put("labelIds", new JSONArray().put("INBOX").put("UNREAD")));
      return page.put("events", events);
    }

    @Override public void schedule(String generation) { scheduled = generation; }
    @Override public void cancel() { scheduled = null; }
    @Override public boolean allowed() { return true; }
    @Override public boolean active(String key) { return active.contains(key); }
    @Override public void post(String key) { fenced(true, "notice post"); active.add(key); }
    @Override public void cancel(String key) { active.remove(key); }
    @Override public void cancelAll() { active.clear(); }

    MailHistoryReconciliation.Guard foreground() {
      return () -> { if (!inForeground) throw new SecurityException("Visit changed"); };
    }
  }

  private static MailBackgroundDelivery delivery(Fixture f) {
    MailBackgroundDelivery.Config config = new MailBackgroundDelivery.Config("https://cloud.example", "test", "google.gmail.triage", 1);
    return MailBackgroundDelivery.withLease(f, f, f, f, config);
  }

  private static String status(Fixture f) throws Exception {
    return new JSONObject(f.state).getString("status");
  }

  private static void resumeWithoutAWatchRetiresEverything() {
    Fixture f = new Fixture();
    f.active.add("stray");
    f.scheduled = "stray";
    delivery(f).resume();
    check(f.active.isEmpty() && f.scheduled == null && f.routes.isEmpty(), "a resume without an admitted watch retires stray notices and work");
  }

  private static void selectionNeedsTheForegroundThroughout() throws Exception {
    Fixture f = new Fixture();
    MailBackgroundDelivery delivery = delivery(f);
    f.inForeground = false;
    refused(() -> delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org", f.foreground()), "a selection made from the background");
    check(f.routes.isEmpty() && f.state == null, "a background selection reads nothing and saves nothing");
    f.inForeground = true;
    f.loseForegroundOnAccounts = true;
    refused(() -> delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org", f.foreground()), "a selection whose visit ended during the grant check");
    check(f.routes.equals(List.of(ACCOUNTS)) && f.state == null && f.scheduled == null, "a late foreground check creates no watch");
  }

  private static void selectionNeedsTheLeaseOfTheNamedOwner() throws Exception {
    List<Fixture> fixtures = new ArrayList<>();
    for (int i = 0; i < 5; i++) fixtures.add(new Fixture());
    fixtures.get(0).binding = null;
    fixtures.get(1).binding = new MailBackgroundDelivery.LeaseBinding("other", FIRST, "owner", "org");
    fixtures.get(2).binding = new MailBackgroundDelivery.LeaseBinding("cred", FIRST, "someone", "org");
    fixtures.get(3).binding = new MailBackgroundDelivery.LeaseBinding("cred", "not-a-digest", "owner", "org");
    fixtures.get(4).reset = true;
    List<String> cases = List.of("no lease", "another credential", "another owner", "a malformed fingerprint", "a pending reset");
    for (int i = 0; i < fixtures.size(); i++) {
      Fixture f = fixtures.get(i);
      MailBackgroundDelivery delivery = delivery(f);
      refused(() -> delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org"), "a selection with " + cases.get(i));
      check(f.routes.isEmpty() && f.state == null && f.scheduled == null, "a selection with " + cases.get(i) + " reads nothing");
    }
  }

  private static void noticesFollowTheExactLease(Fixture f, MailBackgroundDelivery delivery) throws Exception {
    delivery.configure(delivery.begin("grant"), "cred", "grant", "owner", "org", f.foreground());
    JSONObject saved = new JSONObject(f.state).getJSONObject("binding");
    check(saved.getString("credentialDigest").equals(FIRST) && f.scheduled != null, "the watch is pinned to the lease's fingerprint and scheduled");
    check(f.routes.equals(List.of(ACCOUNTS)), "a leased selection checks the grant without the account read");
    check(delivery.sync(f.scheduled, () -> {}) && f.active.isEmpty(), "a baseline completes quietly");
    check(f.routes.contains(LEASED_HISTORY), "a leased baseline read goes to the inbox-v1 history route");
    check(delivery.sync(f.scheduled, () -> {}) && f.active.size() == 1, "an arrival posts one notice");
    check(f.routes.contains(LEASED_HISTORY + "&startHistoryId=100"), "a leased history read continues from its start");
    delivery.capture(f.active.iterator().next(), true);
    JSONObject tap = delivery.pending(f.foreground());
    check(tap.getBoolean("question") && tap.getString("messageId").equals("message"), "an Ask tap names the exact message");
  }

  private static void leasedFailuresAreRetried(Fixture f, MailBackgroundDelivery delivery) throws Exception {
    f.historyStatus = 503;
    check(!delivery.sync(f.scheduled, () -> {}) && status(f).equals("retrying"), "a refused leased read is retried");
    f.historyStatus = 200;
    f.historyBody = new byte[1_100_001];
    check(!delivery.sync(f.scheduled, () -> {}) && status(f).equals("retrying"), "an oversize leased reply is retried, not read");
    f.historyBody = null;
    f.historyStatus = 404;
    check(delivery.sync(f.scheduled, () -> {}) && status(f).equals("unsupported"), "a missing leased history route stops the check");
    f.historyStatus = 200;
    check(f.active.size() == 1, "a failed read withdraws no notice it did not settle");
  }

  private static void aRotatedLeaseRetiresTheWatch(Fixture f, MailBackgroundDelivery delivery) throws Exception {
    String generation = f.scheduled;
    refused(() -> delivery.sync("another-generation", () -> {}), "a job for another generation");
    f.rotateOnHistory = true;
    String before = f.state;
    refused(() -> delivery.sync(generation, () -> {}), "a reply that arrives after the lease rotated");
    check(before.equals(f.state), "a late reply leaves the durable state as it was");
    check(delivery.status().getString("status").equals("disabled"), "a rotated watch is shown as off");
    check(f.active.isEmpty() && f.state == null && f.scheduled == null, "a status read retires the stale watch, its notices and its work before a resume");
    long renewed = delivery.begin("grant");
    delivery.resume();
    delivery.configure(renewed, "cred", "grant", "owner", "org", f.foreground());
    check(f.scheduled != null && f.active.isEmpty(), "a resume leaves a newer foreground selection in place");
  }

  public static void main(String[] args) throws Exception {
    resumeWithoutAWatchRetiresEverything();
    selectionNeedsTheForegroundThroughout();
    selectionNeedsTheLeaseOfTheNamedOwner();
    Fixture f = new Fixture();
    MailBackgroundDelivery delivery = delivery(f);
    noticesFollowTheExactLease(f, delivery);
    leasedFailuresAreRetried(f, delivery);
    aRotatedLeaseRetiresTheWatch(f, delivery);
    check(f.routes.stream().allMatch(path -> path.equals(ACCOUNTS) || path.startsWith(LEASED_HISTORY)), "a leased check reads only the account list and the inbox-v1 history");
    check(f.fenceBreaches.isEmpty(), "every write and lease read holds the fence and every network read leaves it: " + f.fenceBreaches);
    System.out.println("MailBackgroundDeliveryTest checks: " + checks);
  }
}
