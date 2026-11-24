// spec/os/android/noticeRoutes.md, "An approval notice's title is part of its receipt, and a call that names no title means the configured one"
package ai.eliza.plugins.notifications;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

public final class NoticeTitlesTest {
  private static final String APPROVALS = "host-approvals:v1";
  private static final String CONFIGURED = "Step waiting for approval";
  private static final String BODY = "Open the app to review it.";
  private static final NoticeDelivery.Config DELIVERY = new NoticeDelivery.Config("host-notices:v1", APPROVALS, CONFIGURED, BODY, 7L * 86_400_000L);
  private static final NoticeRoutes.Config ROUTES = new NoticeRoutes.Config("host-routes:v1", "host-owner:v1", DELIVERY, "workflowId", "runId", "versionId");
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
    } catch (IllegalStateException | IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("Check " + checks + " should have been refused: " + label);
  }

  static final class Store implements NoticeDelivery.Storage {
    final Map<String, String> values = new HashMap<>();
    public String read(String slot) { return values.get(slot); }
    public void write(String slot, String value) { values.put(slot, value); }
  }

  static final class Poster implements NoticeDelivery.Poster {
    int posts, quiet;
    final Map<String, String> active = new HashMap<>();
    final List<String> cancelled = new ArrayList<>();
    public boolean allowed() { return true; }
    public void post(String id, String title, String body) { posts++; active.put(id, title + "\n" + body); }
    public void postApproval(String id, String title, String body, long timeoutMs) { posts++; active.put(id, title + "\n" + body); }
    public void postApprovalQuiet(String id, String title, String body, long timeoutMs) { quiet++; postApproval(id, title, body, timeoutMs); }
    public void cancel(String id) { cancelled.add(id); active.remove(id); }
    public boolean matches(String id, String title, String body) {
      String shown = active.get(id);
      return shown != null && shown.startsWith(title + "\n") && NoticeDelivery.sameText(body, shown.substring(title.length() + 1));
    }
    public boolean shown(String id) { return active.containsKey(id); }
    public String[] shownText(String id) {
      String shown = active.get(id);
      return shown == null ? null : shown.split("\n", 2);
    }
  }

  private static JSONObject route(String owner, String run) throws Exception {
    return new JSONObject().put("scope", "a".repeat(64)).put("origin", "https://agent.invalid").put("ownerId", owner)
        .put("agentId", "agent").put("workflowId", "workflow").put("runId", run).put("versionId", "v1");
  }

  private static String digest(String title) throws Exception {
    StringBuilder out = new StringBuilder();
    byte[] bytes = new JSONArray().put(title).put(BODY).toString().getBytes(StandardCharsets.UTF_8);
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }

  private static void markUncertain(Store store, String id) throws Exception {
    JSONObject ledger = new JSONObject(store.values.get(APPROVALS));
    ledger.getJSONObject(id).put("status", "unknown");
    store.values.put(APPROVALS, ledger.toString());
  }

  public static void main(String[] args) throws Exception {
    String id = "approval-" + "3".repeat(64), binding = "b".repeat(64), title = "Approve step of Morning brief";
    long now = 1_760_000_000_000L, minute = 60_000L, expires = now + 10 * minute;
    Store store = new Store();
    Poster poster = new Poster();
    NoticeDelivery delivery = new NoticeDelivery(DELIVERY, store, poster);
    NoticeRoutes routes = new NoticeRoutes(store, ROUTES);
    NoticeCoordinator coordinator = new NoticeCoordinator(delivery, routes);

    refused(() -> coordinator.postApproval(id, binding, route("owner", "titled"), "", expires, now), "a blank title");
    check(routes.token(id) == null && poster.posts == 0, "a refused title prepares no route and posts nothing");

    check("succeeded".equals(coordinator.postApproval(id, binding, route("owner", "titled"), title, expires, now)), "a titled approval is published");
    check(poster.active.get(id).equals(title + "\n" + BODY) && poster.posts == 1, "Android shows the approval's own title over the configured body");
    check(digest(title).equals(new JSONObject(store.values.get(APPROVALS)).getJSONObject(id).getString("digest")), "the receipt digest covers the title");

    refused(() -> delivery.publishApproval(id, binding, expires, now + minute), "the configured title for a titled approval");
    refused(() -> delivery.publishApproval(id, binding, "Other title", expires, now + minute), "another title for the same approval");
    check("succeeded".equals(delivery.publishApproval(id, binding, title, expires, now + minute)) && poster.posts == 1, "the same title answers the receipt without posting again");

    markUncertain(store, id);
    poster.active.put(id, CONFIGURED + "\n" + BODY);
    check("unknown".equals(delivery.recheck(id)), "a recheck never confirms a notice showing another title");
    poster.active.put(id, title + "\n" + BODY);
    check("succeeded".equals(delivery.recheck(id)), "a recheck confirms the shown title that reproduces the digest");

    check(coordinator.withdrawOtherOwners(NoticeOwner.fromRoute(route("second", "x")), now + minute) == 1 && !poster.active.containsKey(id), "another owner's fence suspends the titled approval");
    coordinator.withdrawOtherOwners(NoticeOwner.fromRoute(route("owner", "x")), now + 2 * minute);
    refused(() -> coordinator.resumeApproval(id, binding, route("owner", "titled"), expires, now + 2 * minute), "a resume under the configured title");
    check("succeeded".equals(coordinator.resumeApproval(id, binding, route("owner", "titled"), title, expires, now + 2 * minute)) && poster.quiet == 1, "the owner's resume reposts quietly under the same title");
    check(poster.active.get(id).equals(title + "\n" + BODY), "the resumed notice keeps its title");

    coordinator.withdrawApproval(id, now + 3 * minute);
    check(poster.cancelled.contains(id) && !poster.active.containsKey(id) && routes.token(id) == null, "a withdrawal cancels the titled notice and forgets its route");
    check("withdrawn".equals(coordinator.postApproval(id, binding, route("owner", "titled"), title, expires, now + 4 * minute)) && poster.posts == 2, "a withdrawn approval never posts again");

    String plain = "approval-" + "4".repeat(64);
    check("succeeded".equals(coordinator.postApproval(plain, binding, route("owner", "plain"), expires, now)), "an approval without a title is published");
    check(poster.active.get(plain).equals(CONFIGURED + "\n" + BODY) && digest(CONFIGURED).equals(new JSONObject(store.values.get(APPROVALS)).getJSONObject(plain).getString("digest")), "no title means the configured one");
    check("succeeded".equals(delivery.publishApproval(plain, binding, null, expires, now + minute)), "a null title matches the configured receipt");
    System.out.println("NoticeTitlesTest checks: " + checks);
  }
}
