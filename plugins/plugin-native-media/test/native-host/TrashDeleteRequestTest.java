import ai.eliza.plugins.media.TrashDeleteRequest;
import org.json.JSONArray;
import org.json.JSONObject;

/** JVM checks for the trash removal target: "everything" is only an explicit intent. */
public final class TrashDeleteRequestTest {
  private static int checks;
  private static void check(boolean value) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Failing body) {
    checks++;
    try {
      body.run();
    } catch (IllegalArgumentException expected) {
      return;
    } catch (Exception other) {
      throw new AssertionError("Check " + checks + ": " + other);
    }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  private static JSONObject item(String id, String revision) throws Exception {
    return new JSONObject().put("id", id).put("revision", revision);
  }

  public static void main(String[] args) throws Exception {
    // A null or empty selection never widens to the whole trash.
    rejects(() -> TrashDeleteRequest.named(null));
    rejects(() -> TrashDeleteRequest.named(new JSONArray()));
    // Bridge payloads: items null, a non-list items, no intent, and a non-true "all" are refused.
    rejects(() -> TrashDeleteRequest.fromPayload(null));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject()));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject().put("items", JSONObject.NULL)));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject().put("items", "12")));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject().put("items", new JSONObject())));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject().put("all", "true")));
    rejects(() -> TrashDeleteRequest.fromPayload(new JSONObject().put("all", false)));
    rejects(
        () ->
            TrashDeleteRequest.fromPayload(
                new JSONObject().put("all", true).put("items", new JSONArray().put(item("12", "1:2")))));
    // Malformed named rows.
    rejects(() -> TrashDeleteRequest.named(new JSONArray().put("12")));
    rejects(() -> TrashDeleteRequest.named(new JSONArray().put(item("x12", "1:2"))));
    rejects(() -> TrashDeleteRequest.named(new JSONArray().put(item("12", ""))));
    rejects(() -> TrashDeleteRequest.named(new JSONArray().put(new JSONObject().put("id", 12).put("revision", "1:2"))));
    rejects(() -> TrashDeleteRequest.named(new JSONArray().put(item("12", "1:2")).put(item("12", "1:3"))));
    JSONArray tooMany = new JSONArray();
    for (int i = 1; i <= TrashDeleteRequest.MAX_NAMED + 1; i++) tooMany.put(item(Integer.toString(i), "1:2"));
    rejects(() -> TrashDeleteRequest.named(tooMany));

    // Explicit intents.
    TrashDeleteRequest all = TrashDeleteRequest.fromPayload(new JSONObject().put("all", true));
    check(all.isAll());
    check(all.items().isEmpty());
    check(TrashDeleteRequest.all().isAll());
    TrashDeleteRequest named =
        TrashDeleteRequest.fromPayload(
            new JSONObject().put("items", new JSONArray().put(item("12", "1:2")).put(item("v:7", "3:4"))));
    check(!named.isAll());
    check(named.items().size() == 2);
    check("1:2".equals(named.items().get("12")));
    check("3:4".equals(named.items().get("v:7")));
    System.out.println(checks + " trash request checks passed");
  }
}
