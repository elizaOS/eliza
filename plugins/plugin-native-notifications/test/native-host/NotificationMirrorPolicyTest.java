import ai.eliza.plugins.notifications.NotificationMirrorConfig;
import ai.eliza.plugins.notifications.NotificationMirrorPolicy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** JVM tests with synthetic package names only; no Android framework, notifications or accounts. */
public final class NotificationMirrorPolicyTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private interface Failing { void run() throws Exception; }
  private static void rejects(String reason, Failing body) {
    checks++;
    try { body.run(); } catch (IllegalArgumentException expected) {
      if (reason != null && !reason.equals(expected.getMessage())) throw new AssertionError("Check " + checks + ": " + expected.getMessage());
      return;
    } catch (Exception other) { throw new AssertionError("Check " + checks + ": " + other); }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  static final class Listener {}

  public static void main(String[] args) {
    // Host configuration: bounded identifiers, distinct storage, a listener component.
    NotificationMirrorConfig config = new NotificationMirrorConfig("host-notification-access", "host.notification.history.v1", "notification-history.enc", Listener.class);
    check(config.preferencesName.equals("host-notification-access") && config.listener == Listener.class);
    rejects(null, () -> new NotificationMirrorConfig("Host Prefs", "a", "b", Listener.class));
    rejects(null, () -> new NotificationMirrorConfig("a", "a/../b", "b", Listener.class));
    rejects(null, () -> new NotificationMirrorConfig("a", "b", "", Listener.class));
    rejects(null, () -> new NotificationMirrorConfig("a", "b", "c", null));
    rejects(null, () -> new NotificationMirrorConfig("same", "b", "same", Listener.class));
    rejects(null, () -> new NotificationMirrorConfig("x".repeat(65), "b", "c", Listener.class));

    // Observation requires owner enablement, no pause and the Android grant.
    check(NotificationMirrorPolicy.active(true, false, true));
    check(!NotificationMirrorPolicy.active(false, false, true));
    check(!NotificationMirrorPolicy.active(true, true, true));
    check(!NotificationMirrorPolicy.active(true, false, false));
    check(NotificationMirrorPolicy.keepsHistory(true, true, true, false));
    check(!NotificationMirrorPolicy.keepsHistory(true, true, false, false));
    check(!NotificationMirrorPolicy.keepsHistory(false, true, true, false));
    check(!NotificationMirrorPolicy.keepsHistory(true, true, true, true));

    // Selection: visible launcher choices only, no duplicates, at most 20, changed apps re-chosen.
    Set<String> visible = Set.of("org.example.mail", "org.example.chat", "org.example.bank");
    NotificationMirrorPolicy.checkSelection(List.of("org.example.mail", "org.example.chat"), visible, Map.of("org.example.mail", true));
    check(true);
    rejects("This app is unavailable", () -> NotificationMirrorPolicy.checkSelection(List.of("org.example.hidden"), visible, Map.of()));
    rejects("This app is unavailable", () -> NotificationMirrorPolicy.checkSelection(List.of("org.example.mail", "org.example.mail"), visible, Map.of()));
    rejects("Remove and select this changed app again", () -> NotificationMirrorPolicy.checkSelection(List.of("org.example.bank"), visible, Map.of("org.example.bank", false)));
    List<String> many = new ArrayList<>();
    for (int i = 0; i < 21; i++) many.add("org.example.app" + i);
    rejects("Choose at most 20 apps", () -> NotificationMirrorPolicy.checkSelection(many, Set.copyOf(many), Map.of()));
    NotificationMirrorPolicy.checkSelection(List.of(), visible, Map.of("org.example.bank", false));
    check(true);

    // Admission: another package, same user, its own uid, still-matching pinned signature.
    check(NotificationMirrorPolicy.admits(true, false, true, true));
    check(!NotificationMirrorPolicy.admits(false, false, true, true));
    check(!NotificationMirrorPolicy.admits(true, true, true, true));
    check(!NotificationMirrorPolicy.admits(true, false, false, true));
    check(!NotificationMirrorPolicy.admits(true, false, true, false));

    // Redaction and opening.
    check(NotificationMirrorPolicy.hidden(false, false));
    check(NotificationMirrorPolicy.hidden(true, true));
    check(!NotificationMirrorPolicy.hidden(true, false));
    check(NotificationMirrorPolicy.canOpen(false, true, 10123, 10123));
    check(!NotificationMirrorPolicy.canOpen(true, true, 10123, 10123));
    check(!NotificationMirrorPolicy.canOpen(false, false, 10123, 10123));
    check(!NotificationMirrorPolicy.canOpen(false, true, 10999, 10123));

    // Retention and bounds.
    long now = 1_800_000_000_000L;
    check(NotificationMirrorPolicy.retained(now - 1, now));
    check(NotificationMirrorPolicy.retained(now, now));
    check(!NotificationMirrorPolicy.retained(now + 1, now));
    check(!NotificationMirrorPolicy.retained(now - NotificationMirrorPolicy.HISTORY_RETENTION_MS, now));
    check(NotificationMirrorPolicy.bounded(null, 5).isEmpty());
    check(NotificationMirrorPolicy.bounded("abcdefgh", 5).equals("abcde"));
    check(NotificationMirrorPolicy.bounded("abc", 5).equals("abc"));
    check(NotificationMirrorPolicy.INITIAL_POLICY.contains("\"enabled\":false") && NotificationMirrorPolicy.INITIAL_POLICY.contains("\"history\":false"));
    System.out.println(checks + " assertions passed");
  }
}
