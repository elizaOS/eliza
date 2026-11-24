// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.Attempt;
import ai.eliza.plugins.signin.CredentialPolicy.Custody;
import ai.eliza.plugins.signin.CredentialPolicy.Duty;
import ai.eliza.plugins.signin.CredentialPolicy.Lease;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseAnswer;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseOffer;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseUse;
import ai.eliza.plugins.signin.CredentialPolicy.MailLeaseUpgrade;
import ai.eliza.plugins.signin.CredentialPolicy.Notice;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.CredentialPolicy.RefreshAnswer;
import ai.eliza.plugins.signin.CredentialPolicy.RejectedOn;
import ai.eliza.plugins.signin.CredentialPolicy.Session;
import ai.eliza.plugins.signin.CredentialPolicy.State;
import ai.eliza.plugins.signin.CredentialPolicy.Step;
import ai.eliza.plugins.signin.CredentialPolicy.Stored;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.LongSupplier;

public final class DeviceCredentialStore implements CredentialReader {
  public static final String NAMESPACE = "sign-in";

  public interface Slots {
    String read(String slot) throws Exception;
    void write(String slot, String value) throws Exception;
    void remove(String slot) throws Exception;
  }

  public static final class StorageFailure extends IllegalStateException {
    StorageFailure(String what, Throwable cause) { super("device credential storage failed: " + what, cause); }
  }

  public record LeaseSecret(String refresh, long refreshExpiresAt) {
    @Override public String toString() { return "LeaseSecret[refreshExpiresAt=" + refreshExpiresAt + "]"; }
  }

  public record Token(String credentialId, String value, Account account, long keyExpiresAt, LeaseSecret lease) {
    public Token(String credentialId, String value, Account account, long keyExpiresAt) { this(credentialId, value, account, keyExpiresAt, null); }
    LeaseOffer offer() { return lease == null ? CredentialPolicy.NO_OFFER : new LeaseOffer.Offered(lease.refreshExpiresAt()); }
    @Override public String toString() { return "Token[credentialId=" + credentialId + ", account=" + account + ", keyExpiresAt=" + keyExpiresAt + ", lease=" + (lease != null) + "]"; }
  }

  public record Pending(int attempt, String credentialId, String value) {
    @Override public String toString() { return "Pending[attempt=" + attempt + ", credentialId=" + credentialId + "]"; }
  }

  public record Owed(int version, String value, String lease, int tries, String successor) {
    @Override public String toString() { return "Owed[version=" + version + ", tries=" + tries + ", lease=" + (lease != null) + "]"; }
  }

  public record HeldLease(int version, String refresh) {
    @Override public String toString() { return "HeldLease[version=" + version + "]"; }
  }

  public enum Outcome { ACCEPTED, REFUSED }

  public enum Kept { KEPT, NOT_KEPT, REFUSED }

  public enum SessionRead { USABLE, START_REFRESH, AWAIT_REFRESH, NONE }
  public record LeaseRead(SessionRead stage, int version) {}
  public record Renewal(int attempt, int version, Account account) {}

  private final Object lock = new Object();
  private final Slots slots;
  private final String prefix;
  private final LongSupplier clock;
  private final List<Listener> listeners = new CopyOnWriteArrayList<>();
  private final Set<Integer> sweep = new TreeSet<>();
  private volatile Runnable verifyAccount = () -> {};
  private volatile Runnable renewKey = () -> {};
  private State state;
  private record Upgrade(int attempt, MailLeaseUpgrade expected) {}
  private Upgrade upgrade;
  private String written = "";

  public DeviceCredentialStore(Slots slots, String authorityDigest, LongSupplier clock) {
    if (authorityDigest == null || !authorityDigest.matches("[0-9a-f]{32}")) throw new IllegalArgumentException("authority digest");
    this.slots = slots;
    this.prefix = NAMESPACE + ":" + authorityDigest + ":";
    this.clock = clock;
    synchronized (lock) {
      String saved = readSlot(recordSlot());
      State loaded = CredentialPolicy.INITIAL;
      if (saved != null) {
        Map<String, Object> record = CredentialJson.object(CredentialJson.parse(saved), "record");
        loaded = CredentialPolicy.restart(CredentialPolicy.state(record.get("state")));
        if (record.containsKey("leaseUpgrade")) {
          int stoppedAttempt = CredentialJson.small(record, "leaseUpgrade");
          if (CredentialPolicy.canSignInEnded(loaded, stoppedAttempt)) loaded = CredentialPolicy.signInEnded(loaded, stoppedAttempt);
        }
        for (Object version : CredentialJson.list(record.get("sweep"), "sweep")) {
          if (!(version instanceof Long v) || v < 1 || v > Integer.MAX_VALUE) throw new CredentialJson.Malformed("sweep");
          sweep.add(v.intValue());
        }
      }
      state = loaded;
      persist(loaded, Set.of());
      sweepKeys();
      advance();
    }
  }

  public static String authorityDigest(String apiOrigin) {
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(apiOrigin.getBytes(StandardCharsets.UTF_8));
      StringBuilder hex = new StringBuilder(32);
      for (int i = 0; i < 16; i++) hex.append(Character.forDigit((hash[i] & 255) >> 4, 16)).append(Character.forDigit(hash[i] & 15, 16));
      return hex.toString();
    } catch (NoSuchAlgorithmException missing) {
      throw new IllegalStateException(missing);
    }
  }

  public void onVerifyAccount(Runnable verify) { verifyAccount = verify; }

  public void onRenewKey(Runnable renew) { renewKey = renew; }

  public State state() {
    synchronized (lock) { advance(); return state; }
  }

  public int generation() {
    synchronized (lock) { return state.generation(); }
  }

  @Override public Credential current() {
    synchronized (lock) {
      advance();
      if (!(state.custody() instanceof Custody.Active a)) return null;
      return new Credential(a.version(), a.credentialId(), keyOf(a.version()), a.account(), a.keyExpiresAt());
    }
  }

  @Override public Account account() {
    synchronized (lock) { advance(); return CredentialPolicy.accountOf(state); }
  }

  @Override public Subscription listen(Listener listener) {
    listeners.add(listener);
    return () -> listeners.remove(listener);
  }

  @Override public void report401(int version, String reason) {
    rejected(version, reasonOf(reason), RejectedOn.OTHER_REQUEST);
  }

  static Reason reasonOf(String reason) {
    for (Reason known : Reason.values()) if (known.tag.equals(reason)) return known;
    return Reason.ofWire(reason);
  }

  public int beginSignIn() {
    List<Notice> out;
    int attempt;
    synchronized (lock) {
      advance();
      out = commit(new Step(CredentialPolicy.beginSignIn(state), List.of()));
      attempt = state.generation();
    }
    deliver(out);
    return attempt;
  }

  public int beginMailLeaseUpgrade(MailLeaseUpgrade expected) {
    synchronized (lock) {
      advance();
      if (!(state.attempt() instanceof Attempt.NoAttempt) || !CredentialPolicy.mailLeaseUpgradeAdmits(state, expected)) return 0;
      State next = CredentialPolicy.beginSignIn(state);
      commit(new Step(next, List.of()), new Upgrade(next.generation(), expected));
      return next.generation();
    }
  }

  public boolean isMailLeaseUpgrade(int attempt) {
    synchronized (lock) { return upgrade != null && upgrade.attempt() == attempt; }
  }

  public Kept tokenAnswered(int attempt, Token token) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canTokenAnswered(state, attempt, token.credentialId(), token.account(), token.keyExpiresAt(), token.offer())) return Kept.REFUSED;
      int version = state.lastVersion() + 1;
      int active = CredentialPolicy.activeVersion(state);
      String binding = CredentialPolicy.isRenewal(state.attempt()) && active > 0
        ? bindingOf(active) : fingerprint(token.value());
      Stored stored = writeKey(version, token, binding);
      if (stored == Stored.WRITTEN && token.lease() != null) stored = writeLease(version, token.lease().refresh());
      commit(new Step(CredentialPolicy.tokenAnswered(state, attempt, token.credentialId(), token.account(), token.keyExpiresAt(), token.offer(), stored), List.of()));
      return stored == Stored.WRITTEN ? Kept.KEPT : Kept.NOT_KEPT;
    }
  }

  public Outcome acknowledged(int attempt, String credentialId, long keyExpiresAt) {
    List<Notice> out;
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canAcknowledged(state, attempt, credentialId, keyExpiresAt)) return Outcome.REFUSED;
      if (!upgradeStillAdmitted()) return Outcome.REFUSED;
      if (state.attempt() instanceof Attempt.Acknowledging k && k.lease() instanceof LeaseOffer.Renewal && state.lease() instanceof Lease.Held held
        && writeLease(k.version(), leaseOf(held.version())) != Stored.WRITTEN) throw new StorageFailure("lease " + k.version(), null);
      out = commit(CredentialPolicy.acknowledged(state, attempt, credentialId, keyExpiresAt));
    }
    deliver(out);
    return Outcome.ACCEPTED;
  }

  public Renewal beginRenewal() {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canBeginRenewal(state)) return null;
      commit(new Step(CredentialPolicy.beginRenewal(state), List.of()));
      return new Renewal(state.generation(), CredentialPolicy.leaseVersionOf(state.lease()), CredentialPolicy.accountOf(state));
    }
  }

  public boolean renewDue() {
    synchronized (lock) { advance(); return CredentialPolicy.renewDue(state); }
  }

  public HeldLease lease() {
    synchronized (lock) {
      advance();
      int version = CredentialPolicy.leaseVersionOf(state.lease());
      return version == 0 ? null : new HeldLease(version, leaseOf(version));
    }
  }

  public int usableLeaseVersion() {
    synchronized (lock) {
      advance();
      return CredentialPolicy.leaseUsable(state) ? CredentialPolicy.leaseVersionOf(state.lease()) : 0;
    }
  }

  public LeaseRead readLease() {
    synchronized (lock) {
      advance();
      int version = CredentialPolicy.leaseVersionOf(state.lease());
      if (CredentialPolicy.leaseUsable(state)) return new LeaseRead(SessionRead.USABLE, version);
      if (!CredentialPolicy.canReadLease(state)) return new LeaseRead(SessionRead.NONE, 0);
      boolean start = commit(CredentialPolicy.readLease(state)).stream().anyMatch(n -> n instanceof Notice.RefreshLease);
      return new LeaseRead(start ? SessionRead.START_REFRESH : SessionRead.AWAIT_REFRESH, version);
    }
  }

  public Kept leaseRotated(int version, String refresh, long accessExpiresAt, long refreshExpiresAt) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canLeaseRefreshAnswered(state, version)) return Kept.REFUSED;
      boolean fits = accessExpiresAt > state.now() && refreshExpiresAt > state.now();
      Stored stored = fits ? writeLease(version, refresh) : Stored.REFUSED;
      LeaseAnswer rotation = new LeaseAnswer.Rotated(accessExpiresAt, refreshExpiresAt, stored);
      boolean taken = CredentialPolicy.rotationTaken(state, rotation);
      commit(new Step(CredentialPolicy.leaseRefreshAnswered(state, version, rotation), List.of()));
      return taken ? Kept.KEPT : Kept.NOT_KEPT;
    }
  }

  public Outcome leaseUnanswered(int version) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canLeaseRefreshAnswered(state, version)) return Outcome.REFUSED;
      commit(new Step(CredentialPolicy.leaseRefreshAnswered(state, version, new LeaseAnswer.Unanswered()), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  public Outcome leaseRejected(int version, Reason reason, LeaseUse presented) {
    List<Notice> out;
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canLeaseRejected(state, version, reason)) return Outcome.REFUSED;
      out = commit(CredentialPolicy.leaseRejected(state, version, reason, presented));
    }
    deliver(out);
    return Outcome.ACCEPTED;
  }

  public Outcome signInEnded(int attempt) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canSignInEnded(state, attempt)) return Outcome.REFUSED;
      commit(new Step(CredentialPolicy.signInEnded(state, attempt), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  public Outcome adoptSignIn(int generation) {
    synchronized (lock) {
      advance();
      if (generation < 1 || state.generation() != generation || !(state.attempt() instanceof Attempt.NoAttempt)) return Outcome.REFUSED;
      commit(new Step(state.with(new Attempt.Exchanging(generation)), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  public Outcome rejected(int version, Reason reason, RejectedOn on) {
    List<Notice> out;
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canRejected(state, version, reason)) return Outcome.REFUSED;
      out = commit(CredentialPolicy.rejected(state, version, reason, on));
    }
    deliver(out);
    return Outcome.ACCEPTED;
  }

  public void signOut() {
    List<Notice> out;
    synchronized (lock) {
      advance();
      out = commit(CredentialPolicy.signOut(state));
    }
    deliver(out);
  }

  public void reset() {
    List<Notice> out;
    synchronized (lock) {
      advance();
      out = commit(CredentialPolicy.reset(state));
    }
    deliver(out);
  }

  public Outcome revokeAnswered(int version, boolean settled) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canRevokeAnswered(state, version)) return Outcome.REFUSED;
      commit(new Step(CredentialPolicy.revokeAnswered(state, version, settled), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  public Pending pending() {
    synchronized (lock) {
      advance();
      if (!(state.attempt() instanceof Attempt.Acknowledging k)) return null;
      return new Pending(k.attempt(), k.credentialId(), keyOf(k.version()));
    }
  }

  public boolean maySendAcknowledgement(Pending pending) {
    synchronized (lock) {
      advance();
      if (!(state.attempt() instanceof Attempt.Acknowledging current) || current.attempt() != pending.attempt()
          || !current.credentialId().equals(pending.credentialId())) return false;
      return upgradeStillAdmitted();
    }
  }

  public Pending pendingRenewal() {
    synchronized (lock) {
      advance();
      return CredentialPolicy.isRenewal(state.attempt()) ? pending() : null;
    }
  }

  public List<Owed> owed() {
    synchronized (lock) {
      advance();
      List<Owed> out = new ArrayList<>();
      for (Duty d : state.duties()) if (d.tries() > 0) out.add(new Owed(d.version(), keyOf(d.version()), d.lease() ? leaseOf(d.version()) : null, d.tries(), d.successor()));
      return out;
    }
  }

  public boolean grantSession(Account account, long accessExpiresAt) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canGrantSession(state, account, accessExpiresAt)) return false;
      commit(new Step(CredentialPolicy.grantSession(state, account, accessExpiresAt), List.of()));
      return true;
    }
  }

  public Session session() {
    synchronized (lock) { advance(); return state.session(); }
  }

  public boolean sessionUsable() {
    synchronized (lock) { advance(); return CredentialPolicy.sessionUsable(state); }
  }

  public SessionRead readSession() {
    synchronized (lock) {
      advance();
      if (CredentialPolicy.sessionUsable(state)) return SessionRead.USABLE;
      if (!CredentialPolicy.canReadSession(state)) return SessionRead.NONE;
      boolean start = commit(CredentialPolicy.readSession(state)).stream().anyMatch(n -> n instanceof Notice.RefreshAccountSession);
      return start ? SessionRead.START_REFRESH : SessionRead.AWAIT_REFRESH;
    }
  }

  public Outcome refreshAnswered(RefreshAnswer answer) {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canRefreshAnswered(state)) return Outcome.REFUSED;
      commit(new Step(CredentialPolicy.refreshAnswered(state, answer), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  public Outcome dropSession() {
    synchronized (lock) {
      advance();
      if (!CredentialPolicy.canDropSession(state)) return Outcome.REFUSED;
      commit(new Step(CredentialPolicy.dropSession(state), List.of()));
    }
    return Outcome.ACCEPTED;
  }

  private String recordSlot() { return prefix + "credential"; }

  private String keySlot(int version) { return prefix + "key:" + version; }

  private String leaseSlot(int version) { return prefix + "lease:" + version; }

  private void advance() {
    long elapsed = clock.getAsLong() - state.now();
    if (CredentialPolicy.canElapse(state, elapsed)) commit(new Step(CredentialPolicy.elapse(state, elapsed), List.of()));
  }

  private static Set<Integer> held(State s) {
    Set<Integer> versions = new TreeSet<>();
    if (CredentialPolicy.activeVersion(s) >= 1) versions.add(CredentialPolicy.activeVersion(s));
    if (CredentialPolicy.pendingVersion(s) >= 1) versions.add(CredentialPolicy.pendingVersion(s));
    for (Duty d : s.duties()) versions.add(d.version());
    return versions;
  }

  private List<Notice> commit(Step step) {
    Upgrade stillOpen = upgrade != null && CredentialPolicy.attemptOf(step.state()) == upgrade.attempt() ? upgrade : null;
    return commit(step, stillOpen);
  }

  private List<Notice> commit(Step step, Upgrade nextUpgrade) {
    Set<Integer> dropped = held(state);
    dropped.removeAll(held(step.state()));
    persist(step.state(), dropped, nextUpgrade);
    state = step.state();
    upgrade = nextUpgrade;
    sweepKeys();
    return step.out();
  }

  private boolean upgradeStillAdmitted() {
    if (upgrade == null || CredentialPolicy.mailLeaseUpgradeMayAcknowledge(state, upgrade.expected())) return true;
    commit(new Step(CredentialPolicy.signInEnded(state, upgrade.attempt()), List.of()));
    return false;
  }

  private void sweepKeys() {
    List<Integer> removed = new ArrayList<>();
    for (int version : sweep) {
      try {
        slots.remove(keySlot(version));
        slots.remove(leaseSlot(version));
        removed.add(version);
      } catch (Exception unremoved) {
        break;
      }
    }
    removed.forEach(sweep::remove);
  }

  private void persist(State next, Set<Integer> dropped) {
    persist(next, dropped, null);
  }

  private void persist(State next, Set<Integer> dropped, Upgrade nextUpgrade) {
    Set<Integer> owed = new TreeSet<>(sweep);
    owed.addAll(dropped);
    Lease lease = CredentialPolicy.restLease(next.lease());
    State durable = new State(0, next.generation(), next.lastVersion(), next.custody(), next.attempt(), next.duties(), CredentialPolicy.NO_SESSION, lease);
    String upgradeMarker = nextUpgrade == null ? "" : ",\"leaseUpgrade\":" + nextUpgrade.attempt();
    String kept = CredentialPolicy.json(durable) + owed + upgradeMarker;
    if (kept.equals(written)) return;
    State dated = new State(next.now(), next.generation(), next.lastVersion(), next.custody(), next.attempt(), next.duties(), CredentialPolicy.NO_SESSION, lease);
    try {
      slots.write(recordSlot(), "{\"state\":" + CredentialPolicy.json(dated) + ",\"sweep\":" + owed + upgradeMarker + "}");
    } catch (Exception failed) {
      throw new StorageFailure("record", failed);
    }
    written = kept;
    sweep.addAll(dropped);
  }

  private Stored writeKey(int version, Token token, String binding) {
    String value = "{\"credentialId\":" + CredentialJson.quote(token.credentialId()) + ",\"key\":" + CredentialJson.quote(token.value())
      + ",\"binding\":" + CredentialJson.quote(binding) + "}";
    try {
      slots.write(keySlot(version), value);
    } catch (Exception failed) {
      return confirm(version, value);
    }
    return confirm(version, value);
  }

  private Stored writeLease(int version, String refresh) {
    String value = "{\"refresh\":" + CredentialJson.quote(refresh) + "}";
    try {
      slots.write(leaseSlot(version), value);
    } catch (Exception failed) {
      return confirm(leaseSlot(version), value);
    }
    return confirm(leaseSlot(version), value);
  }

  private Stored confirm(int version, String value) { return confirm(keySlot(version), value); }

  private Stored confirm(String slot, String value) {
    try {
      return value.equals(slots.read(slot)) ? Stored.WRITTEN : Stored.FAILED;
    } catch (Exception unreadable) {
      return Stored.UNCONFIRMED;
    }
  }

  private Map<String, Object> keyRecord(int version) {
    String saved = readSlot(keySlot(version));
    if (saved == null) throw new StorageFailure("key " + version + " is missing", null);
    return CredentialJson.object(CredentialJson.parse(saved), "key");
  }

  private String keyOf(int version) {
    return CredentialJson.text(keyRecord(version), "key");
  }

  private String bindingOf(int version) {
    Map<String, Object> stored = keyRecord(version);
    return stored.containsKey("binding") ? CredentialJson.text(stored, "binding") : fingerprint(CredentialJson.text(stored, "key"));
  }

  String accountBinding(String currentSecret) {
    synchronized (lock) {
      Credential current = current();
      return current != null && current.value().equals(currentSecret) ? bindingOf(current.version()) : null;
    }
  }

  private static String fingerprint(String key) {
    try {
      return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256")
        .digest(key.getBytes(StandardCharsets.UTF_8)));
    } catch (NoSuchAlgorithmException unavailable) {
      throw new IllegalStateException(unavailable);
    }
  }

  private String leaseOf(int version) {
    String saved = readSlot(leaseSlot(version));
    if (saved == null) throw new StorageFailure("lease " + version + " is missing", null);
    return CredentialJson.text(CredentialJson.object(CredentialJson.parse(saved), "lease"), "refresh");
  }

  private String readSlot(String slot) {
    try {
      return slots.read(slot);
    } catch (Exception failed) {
      throw new StorageFailure(slot.substring(prefix.length()), failed);
    }
  }

  private void deliver(List<Notice> out) {
    for (Notice notice : out) {
      if (notice instanceof Notice.VerifyAccount) verifyAccount.run();
      else if (notice instanceof Notice.RenewKey) renewKey.run();
      else if (!(notice instanceof Notice.RefreshAccountSession) && !(notice instanceof Notice.RefreshLease)) for (Listener listener : listeners) listener.notice(notice);
    }
  }
}
