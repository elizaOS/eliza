// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"; spec/os/signIn/browserReturn.md, "Story: Come back to the app after a failed browser sign-in"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.BrowserReturnPolicy.BrowserAttempt;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Callback;
import ai.eliza.plugins.signin.BrowserReturnPolicy.CredentialAction;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Pending;
import ai.eliza.plugins.signin.BrowserReturnPolicy.StartChecks;
import ai.eliza.plugins.signin.BrowserReturnPolicy.State;
import ai.eliza.plugins.signin.CredentialPolicy.Attempt;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class BrowserReturnReplay {
  private static final String FAILURE_PATH = "/auth/failed";
  private static final String LINK = "https://links.example.test/open/same";
  private static final String VERIFIER = "v".repeat(64);
  private static final SignInRegistration REGISTRATION = SignInRegistration.parse(Map.of(
    "clientId", "test.client", "testEnvironments", true, "googleMode", "browser", "keyJobs", Map.of("daily", 7101, "renewal", 7102),
    "environments", List.of(
      Map.of("name", "production", "apiOrigin", "https://cloud.example.test", "appLinkHost", "one.example.test", "redirectPath", "/callback"),
      Map.of("name", "staging", "apiOrigin", "https://staging.example.test", "appLinkHost", "two.example.test", "redirectPath", "/callback"))));

  private static final class Memory implements SecureSlot, DeviceCredentialStore.Slots {
    final Map<String, String> held = new HashMap<>();
    boolean failDelete;
    String value;

    @Override public String read() { return value; }

    @Override public boolean compareExchange(String expected, String next) throws Exception {
      if (next == null && failDelete) throw new IllegalStateException("the store could not confirm the delete");
      if (!Objects.equals(expected, value)) return false;
      value = next;
      return true;
    }

    @Override public String read(String slot) { return held.get(slot); }
    @Override public void write(String slot, String next) { held.put(slot, next); }
    @Override public void remove(String slot) { held.remove(slot); }
  }

  private static final class Links implements SecureSlot {
    String value;
    @Override public String read() { return value; }
    @Override public boolean compareExchange(String expected, String next) {
      if (!Objects.equals(expected, value)) return false;
      value = next;
      return true;
    }
  }

  private static final BrowserReturns.Port QUIET = new BrowserReturns.Port() {
    @Override public void handed(BrowserReturns.Handoff handoff) {}
    @Override public void ended(String client, int generation, BrowserReturns.Ended why) {}
    @Override public void incomplete(String client) {}
  };

  private Memory slots;
  private Links linkSlot;
  private long now;
  private DeviceCredentialStore store;
  private BrowserReturns returns;
  private DeepLinkCapture links;

  private void relaunch(String link) throws Exception {
    store = new DeviceCredentialStore(slots, DeviceCredentialStore.authorityDigest("https://cloud.example.test"), () -> now);
    returns = new BrowserReturns(slots, store, QUIET);
    links = DeepLinkCapture.launch(linkSlot, link);
  }

  private void reset() throws Exception {
    slots = new Memory();
    linkSlot = new Links();
    now = 0;
    relaunch(null);
  }

  private static String client(long n) { return n == 1 ? "production" : n == 2 ? "staging" : n >= 1 ? "client-" + n : ""; }

  private static long client(String name) {
    return switch (name) {
      case "production" -> 1;
      case "staging" -> 2;
      default -> Long.parseLong(name.substring("client-".length()));
    };
  }

  private static String nonce(long n) { return n >= 1 ? String.format("%043d", n) : ""; }

  private static StartChecks checks(Map<String, Object> c) {
    return new StartChecks(CredentialJson.flag(c, "registered"), CredentialJson.flag(c, "originValid"), CredentialJson.flag(c, "proofValid"),
      CredentialJson.flag(c, "appLinkVerified"));
  }

  private static Callback callback(long client, long nonce) {
    String state = nonce(nonce);
    if (client == 1 || client == 2) {
      String host = REGISTRATION.environment(client(client)).appLinkHost;
      Callback parsed = BrowserReturnPolicy.parseCallback("https://" + host + "/callback#code=c0de&state=" + state, REGISTRATION.environments());
      if (state.isEmpty() || parsed instanceof Callback.Code) return parsed;
      throw new IllegalStateException("the callback for client " + client + " did not parse");
    }
    return new Callback.Code(client(client), state, "c0de");
  }

  private boolean burnFails(Map<String, Object> e) {
    return switch (CredentialJson.text(e, "burn")) {
      case "Burned" -> false;
      case "BurnUnconfirmed" -> true;
      default -> throw new CredentialJson.Malformed("burn");
    };
  }

  private boolean apply(Map<String, Object> e) throws Exception {
    String type = CredentialJson.text(e, "type");
    switch (type) {
      case "start" -> {
        return returns.start(client(CredentialJson.whole(e, "client")), nonce(CredentialJson.whole(e, "nonce")), VERIFIER,
          BrowserReturns.Purpose.SIGN_IN, checks(CredentialJson.object(e.get("checks"), "checks"))) != null;
      }
      case "returned" -> {
        slots.failDelete = burnFails(e);
        try {
          Callback found = callback(CredentialJson.whole(e, "client"), CredentialJson.whole(e, "nonce"));
          return found != null && returns.returned(found) != BrowserReturns.Return.IGNORED;
        } finally {
          slots.failDelete = false;
        }
      }
      case "elapse" -> {
        long ms = CredentialJson.whole(e, "ms");
        if (!BrowserReturnPolicy.canElapse(ms)) return false;
        now += ms;
        returns.elapsed();
        return true;
      }
      case "credentialActed" -> {
        CredentialAction kind = switch (CredentialJson.text(e, "kind")) {
          case "AnotherSignIn" -> CredentialAction.ANOTHER_SIGN_IN;
          case "SignOutAction" -> CredentialAction.SIGN_OUT;
          case "ResetAction" -> CredentialAction.RESET;
          default -> throw new CredentialJson.Malformed("kind");
        };
        switch (kind) {
          case ANOTHER_SIGN_IN -> store.beginSignIn();
          case SIGN_OUT -> store.signOut();
          case RESET -> store.reset();
        }
        returns.credentialActed(kind);
        return true;
      }
      case "processRestarted" -> {
        relaunch(null);
        return true;
      }
      case "retired" -> {
        slots.failDelete = burnFails(e);
        try { return returns.retire(); } finally { slots.failDelete = false; }
      }
      case "failureReturned" -> {
        URI failure = URI.create("https://" + REGISTRATION.production().appLinkHost + FAILURE_PATH + "?code=never-read");
        List<String> hosts = REGISTRATION.environments().stream().map(environment -> environment.appLinkHost).toList();
        if (!BrowserReturnPolicy.failureRoute(failure.getScheme(), failure.getHost(), failure.getPath(), hosts, FAILURE_PATH))
          throw new IllegalStateException("the failure return was not recognised");
        if (CredentialJson.flag(e, "cold")) relaunch(null);
        return true;
      }
      case "linkFollowed" -> {
        URI link = URI.create(LINK);
        List<String> hosts = REGISTRATION.environments().stream().map(environment -> environment.appLinkHost).toList();
        if (BrowserReturnPolicy.parseCallback(LINK, REGISTRATION.environments()) != null
            || BrowserReturnPolicy.failureRoute(link.getScheme(), link.getHost(), link.getPath(), hosts, FAILURE_PATH))
          throw new IllegalStateException("an ordinary link was taken for a sign-in return");
        if (CredentialJson.flag(e, "cold")) relaunch(LINK);
        else links.capture(LINK);
        return true;
      }
      default -> throw new CredentialJson.Malformed("event " + type);
    }
  }

  private static String attempt(Attempt a) {
    if (a instanceof Attempt.NoAttempt) return "{\"tag\":\"NoAttempt\"}";
    if (a instanceof Attempt.Exchanging x) return "{\"tag\":\"Exchanging\",\"attempt\":" + x.attempt() + "}";
    throw new IllegalStateException("a browser return never acknowledges a key: " + a);
  }

  private static String record(Pending p) {
    return p == null ? "{\"tag\":\"NoRecord\"}" : "{\"tag\":\"Record\",\"client\":" + client(p.client()) + ",\"nonce\":" + Long.parseLong(p.nonce())
      + ",\"generation\":" + p.generation() + ",\"expiresAt\":" + p.expiresAt() + "}";
  }

  private static String attempt(BrowserAttempt a) {
    if (a instanceof BrowserAttempt.Waiting w) return "{\"tag\":\"Waiting\",\"client\":" + client(w.client()) + ",\"nonce\":" + Long.parseLong(w.nonce()) + "}";
    if (a instanceof BrowserAttempt.Handed h) return "{\"tag\":\"Handed\",\"client\":" + client(h.client()) + ",\"generation\":" + h.generation()
      + ",\"owner\":\"" + (h.owner() == BrowserReturnPolicy.Owner.LIVE ? "LiveOwner" : "AdoptedOwner") + "\"}";
    return "{\"tag\":\"NoBrowserAttempt\"}";
  }

  private String state() throws Exception {
    State s = returns.state();
    if (!BrowserReturnPolicy.holds(s)) throw new IllegalStateException("the browser-return rules broke: " + s);
    DeepLinkCapture.Pending pending = links.pending();
    return "{\"state\":{\"credential\":{\"generation\":" + s.credential().generation() + ",\"attempt\":" + attempt(s.credential().attempt()) + "}"
      + ",\"record\":" + record(s.record()) + ",\"attempt\":" + attempt(s.attempt()) + ",\"retirement\":\""
      + (s.retirement() == BrowserReturnPolicy.Retirement.SETTLED ? "RetirementSettled" : "RetirementUnconfirmed") + "\""
      + ",\"links\":{\"captured\":" + links.captured() + ",\"pending\":" + (pending == null ? 0 : pending.receipt()) + "}}";
  }

  private String answer(String line) throws Exception {
    Map<String, Object> request = CredentialJson.object(CredentialJson.parse(line), "request");
    if (!request.containsKey("event")) {
      reset();
      return state() + "}";
    }
    boolean accepted = apply(CredentialJson.object(request.get("event"), "event"));
    return state() + ",\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\"}";
  }

  public static void main(String[] args) throws Exception {
    BrowserReturnReplay replay = new BrowserReturnReplay();
    PrintStream printer = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = in.readLine(); line != null; line = in.readLine()) {
      try {
        printer.println(replay.answer(line));
      } catch (Exception broken) {
        printer.println("{\"error\":" + CredentialJson.quote(String.valueOf(broken.getMessage())) + "}");
      }
    }
  }
}
