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

  public enum Purpose { SIGN_IN, REAUTHENTICATE }

  public enum Return { IGNORED, NOT_ADMITTED, HANDED, UNCONFIRMED }

  public record Reservation(String client, int generation, Purpose purpose) {}

  private record Waiting(String client, int generation) {}

  public record Handoff(String client, int generation, Owner owner, Purpose purpose, Callback callback, String verifier) {
    @Override public String toString() { return "Handoff[client=" + client + ", generation=" + generation + ", owner=" + owner + "]"; }
  }

  public interface Port {
    void handed(Handoff handoff);

    void ended(String client, int generation, Ended why);

    void incomplete(String client);
  }

  public static final class StorageFailure extends Exception {
    StorageFailure(Throwable cause) { super("The browser-return slot could not be used", cause); }
  }

  private record Kept(Pending pending, String verifier, Purpose purpose) {
    String encode() {
      return "{\"client\":" + CredentialJson.quote(pending.client()) + ",\"state\":" + CredentialJson.quote(pending.nonce())
        + ",\"verifier\":" + CredentialJson.quote(verifier) + ",\"generation\":" + pending.generation() + ",\"expiresAt\":" + pending.expiresAt()
        + ",\"purpose\":" + CredentialJson.quote(purpose.name()) + "}";
    }

    static Kept decode(String raw) {
      if (raw == null) return null;
      try {
        Map<String, Object> r = CredentialJson.object(CredentialJson.parse(raw), "record");
        Kept kept = new Kept(new Pending(CredentialJson.text(r, "client"), CredentialJson.text(r, "state"), CredentialJson.small(r, "generation"),
          CredentialJson.whole(r, "expiresAt")), CredentialJson.text(r, "verifier"), Purpose.valueOf(CredentialJson.text(r, "purpose")));
        return BrowserReturnPolicy.validState(kept.pending.nonce()) && BrowserReturnPolicy.validVerifier(kept.verifier) && kept.pending.generation() >= 1 ? kept : null;
      } catch (IllegalArgumentException unreadable) {
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

  private Waiting sync() {
    CredentialPolicy.State c = store.state();
    if (attempt instanceof BrowserAttempt.Waiting w
        && (c.generation() != waitingGeneration || !c.attempt().equals(new Attempt.Exchanging(waitingGeneration)))) {
      attempt = BrowserReturnPolicy.NO_ATTEMPT;
      return new Waiting(w.client(), waitingGeneration);
    }
    if (attempt instanceof BrowserAttempt.Handed h && c.generation() != h.generation()) attempt = BrowserReturnPolicy.NO_ATTEMPT;
    return null;
  }

  private void superseded(Waiting waiting) {
    if (waiting != null) port.ended(waiting.client(), waiting.generation(), Ended.SUPERSEDED);
  }

  public State state() {
    Waiting dropped;
    State now;
    synchronized (lock) {
      dropped = sync();
      now = state(kept());
    }
    superseded(dropped);
    return now;
  }

  public Reservation start(String client, String state, String verifier, Purpose purpose, StartChecks checks) throws StorageFailure {
    if (!BrowserReturnPolicy.canStart(client, state, checks) || !BrowserReturnPolicy.validVerifier(verifier)) return null;
    Waiting dropped, replaced = null;
    int generation;
    synchronized (lock) {
      dropped = sync();
      String raw = read();
      State before = state(Kept.decode(raw));
      State planned = BrowserReturnPolicy.start(before, client, state);
      if (attempt instanceof BrowserAttempt.Waiting w) replaced = new Waiting(w.client(), waitingGeneration);
      generation = store.beginSignIn();
      Kept next = new Kept(new Pending(client, state, generation, planned.record().expiresAt()), verifier, purpose);
      boolean written;
      try { written = slot.compareExchange(raw, next.encode()); } catch (Exception failed) { written = false; }
      if (!written) {
        store.signInEnded(generation);
        attempt = BrowserReturnPolicy.NO_ATTEMPT;
        retirement = Retirement.UNCONFIRMED;
        superseded(dropped);
        superseded(replaced);
        throw new StorageFailure(null);
      }
      attempt = planned.attempt();
      waitingGeneration = generation;
      retirement = planned.retirement();
    }
    superseded(dropped);
    superseded(replaced);
    return new Reservation(client, generation, purpose);
  }

  public Return returned(Callback callback) {
    String client, nonce;
    if (callback instanceof Callback.Code code) { client = code.environment(); nonce = code.state(); }
    else if (callback instanceof Callback.Error error) { client = error.environment(); nonce = error.state(); }
    else return Return.IGNORED;
    Waiting dropped;
    Return answer;
    int generation = 0;
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
        generation = kept.pending().generation();
        boolean adopted = !BrowserReturnPolicy.isWaiting(s.attempt());
        if (adopted && kept.purpose() == Purpose.REAUTHENTICATE) {
          boolean burned = burn(raw);
          retirement = burned ? Retirement.SETTLED : Retirement.UNCONFIRMED;
          answer = burned ? Return.NOT_ADMITTED : Return.UNCONFIRMED;
        } else if (adopted && store.adoptSignIn(generation) != DeviceCredentialStore.Outcome.ACCEPTED) {
          answer = Return.NOT_ADMITTED;
        } else {
          boolean burned = burn(raw);
          State next = BrowserReturnPolicy.returned(s, burned);
          attempt = next.attempt();
          retirement = next.retirement();
          if (burned) {
            handoff = new Handoff(client, generation, adopted ? Owner.ADOPTED : Owner.LIVE, kept.purpose(), callback, kept.verifier());
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
      case UNCONFIRMED -> port.ended(client, generation, Ended.STORAGE);
      case NOT_ADMITTED -> port.incomplete(client);
      case IGNORED -> {}
    }
    return answer;
  }

  public boolean elapsed() {
    Waiting dropped, expired = null;
    synchronized (lock) {
      dropped = sync();
      State s = state(kept());
      if (BrowserReturnPolicy.waitingExpired(s)) {
        expired = new Waiting(((BrowserAttempt.Waiting) attempt).client(), waitingGeneration);
        store.signInEnded(waitingGeneration);
        attempt = BrowserReturnPolicy.expired(s).attempt();
      }
    }
    superseded(dropped);
    if (expired != null) port.ended(expired.client(), expired.generation(), Ended.EXPIRED);
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

  public void cancel(Reservation reservation) {
    String client = reservation.client();
    int generation = reservation.generation();
    boolean cancelled = false;
    synchronized (lock) {
      sync();
      if (attempt instanceof BrowserAttempt.Waiting w && w.client().equals(client) && waitingGeneration == generation) {
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
    if (cancelled) port.ended(client, generation, Ended.CANCELLED);
  }

  public void credentialActed(CredentialAction kind) {
    Waiting dropped;
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
        if (attempt instanceof BrowserAttempt.Waiting w) dropped = new Waiting(w.client(), waitingGeneration);
        attempt = BrowserReturnPolicy.NO_ATTEMPT;
      }
    }
    superseded(dropped);
  }

  private boolean burn(String raw) {
    try { return slot.compareExchange(raw, null); } catch (Exception unconfirmed) { return false; }
  }

  private boolean ownsExchange(Handoff handoff) {
    if (!(attempt instanceof BrowserAttempt.Handed h) || h.generation() != handoff.generation() || !h.client().equals(handoff.client())) return false;
    CredentialPolicy.State current = store.state();
    return current.generation() == handoff.generation() && current.attempt().equals(new Attempt.Exchanging(handoff.generation()));
  }

  public boolean mayExchange(Handoff handoff) {
    synchronized (lock) { return ownsExchange(handoff); }
  }

  public boolean takeExchange(Handoff handoff) {
    synchronized (lock) {
      if (!ownsExchange(handoff)) return false;
      attempt = BrowserReturnPolicy.NO_ATTEMPT;
      return true;
    }
  }

  public void exchangeEnded(int generation) {
    synchronized (lock) {
      if (attempt instanceof BrowserAttempt.Handed h && h.generation() == generation) attempt = BrowserReturnPolicy.NO_ATTEMPT;
    }
    store.signInEnded(generation);
  }
}
