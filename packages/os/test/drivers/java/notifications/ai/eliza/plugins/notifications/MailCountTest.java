// spec/os/android/notificationProjection.md, "A new-mail count counts the notices still unread, a notice the shade cap withdrew included"
package ai.eliza.plugins.notifications;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class MailCountTest {
  private static int checks;

  private static void check(boolean value, String label) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks + ": " + label);
  }

  static final class Memory implements MailHistoryReconciliation.Store {
    String raw;
    public String read() { return raw; }
    public void write(String value) { raw = value; }
  }

  static final class CountingPoster implements MailHistoryReconciliation.Poster {
    final Set<String> active = new HashSet<>();
    final List<Integer> counts = new ArrayList<>();
    int posts;
    public boolean allowed() { return true; }
    public boolean active(String key) { return active.contains(key); }
    public void post(String key) { posts++; active.add(key); }
    public void post(String key, int count) { counts.add(count); post(key); }
    public void cancel(String key) { active.remove(key); }
  }

  static final class Mailbox {
    final Memory memory = new Memory();
    final CountingPoster poster = new CountingPoster();
    final MailHistoryReconciliation engine;
    Mailbox() throws Exception {
      JSONObject binding = new JSONObject().put("generation", "generation-a").put("grantId", "grant").put("accountRef", "owner").put("credentialId", "credential").put("userId", "owner");
      memory.raw = MailHistoryReconciliation.initial(binding).toString();
      engine = new MailHistoryReconciliation(memory, () -> {}, poster);
      engine.accept(new JSONObject().put("version", 1).put("grantId", "grant").put("status", "baseline-required").put("startHistoryId", JSONObject.NULL)
          .put("historyId", "100").put("checkpoint", JSONObject.NULL).put("nextPageToken", JSONObject.NULL).put("events", new JSONArray()).put("backfillRequired", true), 1);
    }
    void publishAll() throws Exception {
      while (engine.hasPending()) engine.publish();
    }
  }

  private static JSONObject event(String history, String type, String message, String... labels) throws Exception {
    JSONObject event = new JSONObject().put("id", history + ":" + type + ":" + message).put("historyId", history).put("type", type)
        .put("messageId", message).put("threadId", "thread").put("labelIds", new JSONArray(Arrays.asList(labels)));
    return type.equals("message-added") ? event.put("messageAvailable", true) : event;
  }

  private static JSONObject page(String start, String current, String next, JSONObject... events) throws Exception {
    return new JSONObject().put("version", 1).put("grantId", "grant").put("status", "page").put("startHistoryId", start).put("historyId", current)
        .put("checkpoint", next == null ? current : JSONObject.NULL).put("nextPageToken", next == null ? JSONObject.NULL : next)
        .put("events", new JSONArray(Arrays.asList(events))).put("backfillRequired", false);
  }

  private static JSONObject arrival(int history, String message) throws Exception {
    return event(String.valueOf(history), "message-added", message, "INBOX", "UNREAD");
  }

  public static void main(String[] args) throws Exception {
    Mailbox read = new Mailbox();
    read.engine.accept(page("100", "103", null, arrival(101, "c0"), arrival(102, "c1"), arrival(103, "c2")), 2);
    read.publishAll();
    read.engine.accept(page("103", "105", null, event("104", "labels-removed", "c0", "UNREAD"), arrival(105, "c3")), 3);
    read.publishAll();
    check(read.poster.counts.equals(List.of(3, 3, 3, 3)) && read.poster.posts == 4, "a count names the new unread mail, the read one excluded: " + read.poster.counts);

    Mailbox capped = new Mailbox();
    JSONObject[] seven = new JSONObject[7];
    for (int i = 0; i < seven.length; i++) seven[i] = arrival(101 + i, "k" + i);
    capped.engine.accept(page("100", "110", "next", seven), 2);
    capped.publishAll();
    check(capped.poster.counts.equals(List.of(7, 7, 7, 7, 7, 7, 7)), "a notice the shade cap withdrew still counts: " + capped.poster.counts);
    check(capped.poster.active.size() == MailHistoryReconciliation.MAX_ACTIVE_NOTICES, "the shade keeps its cap");
    capped.engine.accept(page("100", "110", null, event("108", "labels-removed", "k0", "UNREAD"), arrival(109, "k7")), 3);
    capped.publishAll();
    check(capped.poster.counts.size() == 8 && capped.poster.counts.get(7) == 7, "read capped mail no longer counts, unread capped mail still does: " + capped.poster.counts);

    Mailbox deleted = new Mailbox();
    deleted.engine.accept(page("100", "103", null, arrival(101, "d0"), arrival(102, "d1")), 2);
    deleted.publishAll();
    deleted.engine.accept(page("103", "105", null, event("104", "message-deleted", "d0"), arrival(105, "d2")), 3);
    deleted.publishAll();
    check(deleted.poster.counts.equals(List.of(2, 2, 2)), "deleted mail is not counted: " + deleted.poster.counts);

    Mailbox plain = new Mailbox();
    List<String> posted = new ArrayList<>();
    MailHistoryReconciliation.Poster countless = new MailHistoryReconciliation.Poster() {
      public boolean allowed() { return true; }
      public boolean active(String key) { return posted.contains(key); }
      public void post(String key) { posted.add(key); }
      public void cancel(String key) { posted.remove(key); }
    };
    MailHistoryReconciliation engine = new MailHistoryReconciliation(plain.memory, () -> {}, countless);
    engine.accept(page("100", "102", null, arrival(101, "p0")), 2);
    engine.publish();
    check(posted.size() == 1, "a host that shows no count still posts through the default");
    System.out.println("MailCountTest checks: " + checks);
  }
}
