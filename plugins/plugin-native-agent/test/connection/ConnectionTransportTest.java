package ai.eliza.plugins.agent.connection.test;

import ai.eliza.plugins.agent.connection.ConnectionTransport;
import ai.eliza.plugins.agent.connection.DelegationCallback;
import ai.eliza.plugins.agent.connection.PendingRequests;
import ai.eliza.plugins.agent.connection.SecureSlotPolicy;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/** Host-JVM contract of the transport bounds, delegation callback, slot policy and request registry. */
public final class ConnectionTransportTest {
  private static int assertions;

  private static void check(boolean value, String name) {
    assertions++;
    if (!value) throw new AssertionError(name);
  }

  interface Action {
    void run() throws Exception;
  }

  private static void refused(Action action, String name) {
    try {
      action.run();
    } catch (Exception expected) {
      check(true, name);
      return;
    }
    check(false, name);
  }

  private static Map<String, List<String>> query(String... pairs) {
    Map<String, List<String>> values = new HashMap<>();
    for (int i = 0; i < pairs.length; i += 2) values.computeIfAbsent(pairs[i], key -> new ArrayList<>()).add(pairs[i + 1]);
    return values;
  }

  private static DelegationCallback callback(String scheme, String host, int port, String user, String fragment, String path, Map<String, List<String>> query) {
    return DelegationCallback.admit("product", "cloud-delegation", scheme, host, port, user, fragment, path, query);
  }

  static final class Recording implements PendingRequests.Call {
    int resolved, rejected;
    String message;

    public void resolve() {
      resolved++;
    }

    public void reject(String message) {
      rejected++;
      this.message = message;
    }
  }

  public static void main(String[] args) throws Exception {
    // URL validation: HTTPS with a host; development HTTP only with test mocks and the flag.
    check(ConnectionTransport.validatedUrl("https://api.eliza.app/api/v1/user", false, false).getHost().equals("api.eliza.app"), "https admitted");
    check(ConnectionTransport.validatedUrl("http://10.0.2.2:2138/api/status", true, true) != null, "development agent with test mocks");
    check(ConnectionTransport.validatedUrl("http://127.0.0.1:2138/", true, true) != null, "loopback agent with test mocks");
    refused(() -> ConnectionTransport.validatedUrl("http://10.0.2.2:2138/", true, false), "development refused without test mocks");
    refused(() -> ConnectionTransport.validatedUrl("http://10.0.2.2:2138/", false, true), "development refused for external opens");
    for (String text :
        new String[] {
          "http://api.eliza.app/", "https://user@api.eliza.app/", "https://api.eliza.app/#x", "https://api.eliza.app:0/",
          "https://api.eliza.app:70000/", "https:///path", "mailto:x@example.com", "javascript:alert(1)", "", null,
          "https://example.com/" + "a".repeat(ConnectionTransport.VALUE_LIMIT)
        })
      refused(() -> ConnectionTransport.validatedUrl(text, true, true), "URL refused: " + (text == null ? null : text.substring(0, Math.min(40, text.length()))));

    // Strict JSON: exactly one value.
    check(ConnectionTransport.parseJson(" {\"a\":1} ") instanceof org.json.JSONObject, "object parsed");
    check(ConnectionTransport.parseJson("[1]") instanceof org.json.JSONArray, "array parsed");
    refused(() -> ConnectionTransport.parseJson("{} {}"), "trailing value refused");
    refused(() -> ConnectionTransport.parseJson("{\"a\":1}x"), "trailing garbage refused");
    refused(() -> ConnectionTransport.parseJson(""), "empty body refused");

    // Bounded bodies: exactly the limit passes, one byte more is refused.
    check(ConnectionTransport.readBounded(null, 4).length == 0, "absent stream is empty");
    check(ConnectionTransport.readBounded(new ByteArrayInputStream(new byte[4]), 4).length == 4, "limit admitted");
    refused(() -> ConnectionTransport.readBounded(new ByteArrayInputStream(new byte[5]), 4), "oversized body refused");
    refused(() -> ConnectionTransport.readBounded(new ByteArrayInputStream(new byte[ConnectionTransport.RESPONSE_LIMIT + 1]), ConnectionTransport.RESPONSE_LIMIT), "oversized response refused");
    check(ConnectionTransport.required("x", 1).equals("x"), "required value");
    refused(() -> ConnectionTransport.required("xx", 1), "required bound");
    refused(() -> ConnectionTransport.required("", 1), "required non-empty");

    // Header values and Retry-After.
    check(ConnectionTransport.headerValue("Bearer token"), "header admitted");
    check(!ConnectionTransport.headerValue("a\r\nInjected: 1") && !ConnectionTransport.headerValue("a\n") && !ConnectionTransport.headerValue(null), "header injection refused");
    check(!ConnectionTransport.headerValue("a".repeat(ConnectionTransport.VALUE_LIMIT + 1)), "oversized header refused");
    check("120".equals(ConnectionTransport.retryAfter("120")) && ConnectionTransport.retryAfter("Wed, 21 Oct 2026 07:28:00 GMT") != null, "Retry-After forms");
    check(ConnectionTransport.retryAfter("<script>") == null && ConnectionTransport.retryAfter("") == null && ConnectionTransport.retryAfter(null) == null && ConnectionTransport.retryAfter("1".repeat(65)) == null, "unsafe Retry-After dropped");

    // Device capabilities.
    Set<String> allowed = Set.of("notes.v1", "reminders.v1", "reminders.v2");
    String[][] exclusive = {{"reminders.v1", "reminders.v2"}};
    check(ConnectionTransport.deviceCapabilities("notes.v1, reminders.v2", allowed, exclusive), "capabilities admitted");
    for (String value : new String[] {"notes.v1,notes.v1", "unknown", "reminders.v1,reminders.v2", "notes.v1\n", "", null, "notes.v1,reminders.v1,reminders.v2,x"})
      check(!ConnectionTransport.deviceCapabilities(value, allowed, exclusive), "capabilities refused: " + value);

    // Delegation callback.
    String state = "a".repeat(43);
    DelegationCallback code = callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c0de"));
    check(code != null && state.equals(code.state) && "c0de".equals(code.code) && code.error == null, "code callback admitted");
    DelegationCallback denied = callback("product", "cloud-delegation", -1, null, null, "/", query("state", state, "error", "server_error"));
    check(denied != null && denied.code == null && "access_denied".equals(denied.error), "error callback normalised");
    check(callback("product", "cloud-delegation", -1, null, null, null, query("state", state, "code", "c")) != null, "absent path admitted");
    check(callback("other", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c")) == null, "scheme refused");
    check(callback("product", "evil", -1, null, null, "", query("state", state, "code", "c")) == null, "host refused");
    check(callback("product", "cloud-delegation", 443, null, null, "", query("state", state, "code", "c")) == null, "port refused");
    check(callback("product", "cloud-delegation", -1, "user", null, "", query("state", state, "code", "c")) == null, "user info refused");
    check(callback("product", "cloud-delegation", -1, null, "f", "", query("state", state, "code", "c")) == null, "fragment refused");
    check(callback("product", "cloud-delegation", -1, null, null, "/x", query("state", state, "code", "c")) == null, "path refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c", "extra", "1")) == null, "extra parameter refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c", "error", "e")) == null, "code and error refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c", "code", "d")) == null, "repeated code refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", "short", "code", "c")) == null, "short state refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state.substring(1) + "=", "code", "c")) == null, "padded state refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "")) == null, "empty code refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", query("state", state, "code", "c".repeat(DelegationCallback.CODE_LIMIT + 1))) == null, "oversized code refused");
    check(callback("product", "cloud-delegation", -1, null, null, "", null) == null, "missing query refused");

    // Secure slot policy.
    SecureSlotPolicy slots =
        new SecureSlotPolicy(
            List.of("local-agent-provider", "cloud-signin"),
            List.of("(?s)inbox-drafts:v1:.*", "assistant-draft:v1:[a-f0-9]{64}", SecureSlotPolicy.exact("notes-records:v1:device")),
            List.of("cloud:production", "cloud:staging"));
    check("cloud:production".equals(slots.requireRendererSlot("cloud:production")), "credential slot renderer-nameable");
    for (String slot : new String[] {"local-agent-provider", "local-agent-provider:v1", "cloud-signin:pkce", "", null, "x".repeat(SecureSlotPolicy.NAME_LIMIT + 1)})
      refused(() -> slots.requireRendererSlot(slot), "native slot refused: " + slot);
    check(slots.requireRendererSlot("local-agent-providers") != null, "namespace boundary is ':'");
    check(slots.compareExchangeAllowed("inbox-drafts:v1:anything") && slots.compareExchangeAllowed("notes-records:v1:device") && slots.compareExchangeAllowed("assistant-draft:v1:" + "a".repeat(64)), "compare-exchange slots");
    check(!slots.compareExchangeAllowed("cloud:production") && !slots.compareExchangeAllowed("notes-records:v1:devices") && !slots.compareExchangeAllowed("assistant-draft:v1:" + "A".repeat(64)) && !slots.compareExchangeAllowed(null), "compare-exchange never admits credentials or near misses");
    check(slots.credentialSlot("cloud:staging") && !slots.credentialSlot("inbox-drafts:v1:x") && !slots.credentialSlot(null), "credential slots");

    // Pending requests: cancellation disconnects, ids are unique, browser handoffs settle once.
    PendingRequests requests = new PendingRequests();
    PendingRequests.Pending request = requests.register("one");
    check(request != null && requests.register("one") == null, "duplicate id refused");
    AtomicInteger disconnects = new AtomicInteger();
    request.connection(disconnects::incrementAndGet);
    requests.cancel("one");
    check(request.cancelled() && disconnects.get() == 1 && requests.size() == 1, "cancel disconnects; the worker forgets the request");
    requests.remove("one", request);
    requests.cancel("missing");
    check(requests.size() == 0, "unknown cancel is a no-op");

    Recording browser = new Recording();
    PendingRequests.Pending handoff = requests.registerBrowser("login", browser);
    requests.pauseAll();
    requests.resumeAll();
    check(browser.resolved == 0 && requests.size() == 1, "pause before launch does not settle");
    handoff.launch(() -> {});
    requests.resumeAll();
    check(browser.resolved == 0, "resume without pause does not settle");
    requests.pauseAll();
    requests.resumeAll();
    check(browser.resolved == 1 && browser.rejected == 0 && requests.size() == 0, "return after launch settles once");
    requests.pauseAll();
    requests.resumeAll();
    check(browser.resolved == 1, "settled handoff stays settled");

    Recording cancelled = new Recording();
    PendingRequests.Pending cancelledHandoff = requests.registerBrowser("login", cancelled);
    cancelledHandoff.launch(() -> {});
    requests.cancel("login");
    check(cancelled.rejected == 1 && "Request cancelled".equals(cancelled.message) && requests.size() == 0, "cancelled handoff rejects and is forgotten");
    requests.pauseAll();
    requests.resumeAll();
    check(cancelled.resolved == 0, "cancelled handoff never resolves");

    Recording failed = new Recording();
    PendingRequests.Pending failing = requests.registerBrowser("fail", failed);
    failing.launch(() -> {
      throw new IllegalStateException("no browser");
    });
    check(failed.rejected == 1 && "Authentication browser unavailable".equals(failed.message) && failing.settled(), "launch failure rejects");
    requests.remove("fail", failing);

    Recording late = new Recording();
    PendingRequests.Pending lateHandoff = requests.registerBrowser("late", late);
    lateHandoff.cancel();
    AtomicInteger launched = new AtomicInteger();
    lateHandoff.launch(launched::incrementAndGet);
    check(launched.get() == 0 && late.rejected == 1, "a cancelled handoff never launches");
    requests.remove("late", lateHandoff);

    Recording teardown = new Recording();
    requests.registerBrowser("teardown", teardown);
    PendingRequests.Pending open = requests.register("open");
    AtomicInteger closed = new AtomicInteger();
    open.connection(closed::incrementAndGet);
    requests.cancelAll();
    check(teardown.rejected == 1 && closed.get() == 1 && requests.size() == 0, "teardown cancels everything");

    System.out.println("PASS connection transport (" + assertions + " assertions)");
  }
}
