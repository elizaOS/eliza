// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.BrowserReturnPolicy.BrowserAttempt;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Callback;
import ai.eliza.plugins.signin.BrowserReturnPolicy.CredentialAction;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Owner;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Pending;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Retirement;
import ai.eliza.plugins.signin.BrowserReturnPolicy.StartChecks;
import ai.eliza.plugins.signin.BrowserReturnPolicy.State;
import ai.eliza.plugins.signin.CredentialPolicy.Attempt;
import java.util.Map;

public final class BrowserReturns {
  public enum Ended { EXPIRED, STORAGE, SUPERSEDED, CANCELLED }

  public enum Return { IGNORED, NOT_ADMITTED, HANDED, UNCONFIRMED }

  public record Handoff(String client, int generation, Owner owner, Callback callback, String verifier) {
    @Override public String toString() { return "Handoff[client=" + client + ", generation=" + generation + ", owner=" + owner + "]"; }
  }

  public interface Port {
    void handed(Handoff handoff);

    void ended(String client, Ended why);

    void incomplete(String client);
  }

  public static final class StorageFailure extends Exception {
    StorageFailure(Throwable cause) { super("The browser-return slot could not be used", cause); }
  }

  private record Kept(Pending pending, String verifier) {
    String encode() {
      return "{\"client\":" + CredentialJson.quote(pending.client()) + ",\"state\":" + CredentialJson.quote(pending.nonce())
        + ",\"verifier\":" + CredentialJson.quote(verifier) + ",\"generation\":" + pending.generation() + ",\"expiresAt\":" + pending.expiresAt() + "}";
    }

    static Kept decode(String raw) {
      if (raw == null) return null;
      try {
        Map<String, Object> r = CredentialJson.object(CredentialJson.parse(raw), "record");
        Kept kept = new Kept(new Pending(CredentialJson.text(r, "client"), CredentialJson.text(r, "state"), CredentialJson.small(r, "generation"),
          CredentialJson.whole(r, "expiresAt")), CredentialJson.text(r, "verifier"));
        return BrowserReturnPolicy.validState(kept.pending.nonce()) && BrowserReturnPolicy.validVerifier(kept.verifier) && kept.pending.generation() >= 1 ? kept : null;
      } catch (CredentialJson.Malformed unreadable) {
        return null;
      }
    }
  }

  private final SecureSlot slot;
  private final DeviceCredentialStore store;
  private final Port port;
  private final Object lock = new Object();
  private BrowserAttempt attempt = BrowserReturnPolicy.NO_ATTEMPT;
  private int waitingGeneration;
  private Retirement retirement = Retirement.SETTLED;

  public BrowserReturns(SecureSlot slot, DeviceCredentialStore store, Port port) {
    this.slot = slot;
    this.store = store;
    this.port = port;
  }

  private String read() throws StorageFailure {
    try { return slot.read(); } catch (Exception failed) { throw new StorageFailure(failed); }
  }

  private Kept kept() {
    try { return Kept.decode(slot.read()); } catch (Exception unreadable) { return null; }
  }

  private State state(Kept kept) {
    return new State(store.state(), kept == null ? null : kept.pending(), attempt, retirement);
  }

  private String sync() {
    CredentialPolicy.State c = store.state();
    if (attempt instanceof BrowserAttempt.Waiting w
        && (c.generation() != waitingGeneration || !c.attempt().equals(new Attempt.Exchanging(waitingGeneration)))) {
      attempt = BrowserReturnPolicy.NO_ATTEMPT;
      return w.client();
    }
    if (attempt instanceof BrowserAttempt.Handed h && c.generation() != h.generation()) attempt = BrowserReturnPolicy.NO_ATTEMPT;
    return null;
  }

  private void superseded(String client) {
    if (client != null) port.ended(client, Ended.SUPERSEDED);
  }

  public State state() {
    String dropped;
    State now;
    synchronized (lock) {
      dropped = sync();
      now = state(kept());
    }
    superseded(dropped);
    return now;
  }

  public boolean start(String client, String state, String verifier, StartChecks checks) throws StorageFailure {
    if (!BrowserReturnPolicy.canStart(client, state, checks) || !BrowserReturnPolicy.validVerifier(verifier)) return false;
    String dropped, replaced = null;
    synchronized (lock) {
      dropped = sync();
      String raw = read();
      State before = state(Kept.decode(raw));
      State planned = BrowserReturnPolicy.start(before, client, state);
      if (attempt instanceof BrowserAttempt.Waiting w) replaced = w.client();
      int generation = store.beginSignIn();
      Kept next = new Kept(new Pending(client, state, generation, planned.record().expiresAt()), verifier);
      boolean written;
      try { written = slot.compareExchange(raw, next.encode()); } catch (Exception failed) { written = false; }
      if (!written) {
        store.signInEnded(generation);
        attempt = BrowserReturnPolicy.NO_ATTEMPT;
        superseded(dropped);
        if (replaced != null) port.ended(replaced, Ended.SUPERSEDED);
        throw new StorageFailure(null);
      }
      attempt = planned.attempt();
      waitingGeneration = generation;
      retirement = planned.retirement();
    }
    superseded(dropped);
    if (replaced != null) port.ended(replaced, Ended.SUPERSEDED);
    return true;
  }

  public Return returned(Callback callback) {
    String client, nonce;
    if (callback instanceof Callback.Code code) { client = code.environment(); nonce = code.state(); }
    else if (callback instanceof Callback.Error error) { client = error.environment(); nonce = error.state(); }
    else return Return.IGNORED;
    String dropped;
    Return answer;
    Handoff handoff = null;
    synchronized (lock) {
      dropped = sync();
      String raw;
      try { raw = slot.read(); } catch (Exception unreadable) { raw = null; }
      Kept kept = Kept.decode(raw);
      State s = state(kept);
      if (!BrowserReturnPolicy.canReturned(s, client, nonce)) answer = Return.IGNORED;
      else if (!BrowserReturnPolicy.returnAdmitted(s)) answer = Return.NOT_ADMITTED;
      else {
        int generation = kept.pending().generation();
        boolean adopted = !BrowserReturnPolicy.isWaiting(s.attempt());
        if (adopted && store.adoptSignIn(generation) != DeviceCredentialStore.Outcome.ACCEPTED) answer = Return.NOT_ADMITTED;
        else {
          boolean burned;
          try { burned = slot.compareExchange(raw, null); } catch (Exception unconfirmed) { burned = false; }
          State next = BrowserReturnPolicy.returned(s, burned);
          attempt = next.attempt();
          retirement = next.retirement();
          if (burned) {
            handoff = new Handoff(client, generation, adopted ? Owner.ADOPTED : Owner.LIVE, callback, kept.verifier());
            answer = Return.HANDED;
          } else {
            store.signInEnded(generation);
            answer = Return.UNCONFIRMED;
          }
        }
      }
    }
    superseded(dropped);
    switch (answer) {
      case HANDED -> port.handed(handoff);
      case UNCONFIRMED -> port.ended(client, Ended.STORAGE);
      case NOT_ADMITTED -> port.incomplete(client);
      case IGNORED -> {}
    }
    return answer;
  }

  public boolean elapsed() {
    String dropped, expired = null;
    synchronized (lock) {
      dropped = sync();
      State s = state(kept());
      if (BrowserReturnPolicy.waitingExpired(s)) {
        expired = ((BrowserAttempt.Waiting) attempt).client();
        store.signInEnded(waitingGeneration);
        attempt = BrowserReturnPolicy.expired(s).attempt();
      }
    }
    superseded(dropped);
    if (expired != null) port.ended(expired, Ended.EXPIRED);
    return expired != null;
  }

  public boolean retire() {
    synchronized (lock) {
      sync();
      if (!BrowserReturnPolicy.canRetired(state(null))) return false;
      boolean burned;
      try {
        String raw = slot.read();
        burned = raw == null || slot.compareExchange(raw, null);
      } catch (Exception unconfirmed) {
        burned = false;
      }
      retirement = burned ? Retirement.SETTLED : retirement;
      return true;
    }
  }

  public void cancel(String client) {
    boolean cancelled = false;
    synchronized (lock) {
      sync();
      if (attempt instanceof BrowserAttempt.Waiting w && w.client().equals(client)) {
        cancelled = true;
        store.signInEnded(waitingGeneration);
        attempt = BrowserReturnPolicy.NO_ATTEMPT;
        boolean burned;
        try {
          String raw = slot.read();
          Kept kept = Kept.decode(raw);
          burned = kept == null || kept.pending().generation() != waitingGeneration || slot.compareExchange(raw, null);
        } catch (Exception unconfirmed) {
          burned = false;
        }
        if (!burned) retirement = Retirement.UNCONFIRMED;
      }
    }
    if (cancelled) port.ended(client, Ended.CANCELLED);
  }

  public void credentialActed(CredentialAction kind) {
    String dropped;
    synchronized (lock) {
      dropped = sync();
      if (kind != CredentialAction.ANOTHER_SIGN_IN) {
        try {
          String raw = slot.read();
          if (raw != null) slot.compareExchange(raw, null);
        } catch (Exception staleByGeneration) {
          retirement = Retirement.SETTLED;
        }
        retirement = Retirement.SETTLED;
        if (attempt instanceof BrowserAttempt.Waiting w) dropped = w.client();
        attempt = BrowserReturnPolicy.NO_ATTEMPT;
      }
    }
    superseded(dropped);
  }

  public void exchangeEnded(int generation) {
    synchronized (lock) {
      if (attempt instanceof BrowserAttempt.Handed h && h.generation() == generation) attempt = BrowserReturnPolicy.NO_ATTEMPT;
    }
    store.signInEnded(generation);
  }
}
