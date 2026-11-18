// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class CredentialPolicy {
  private CredentialPolicy() {}

  public static final long MILLIS_PER_MINUTE = 60_000L;
  public static final long ACK_WINDOW_MS = 5 * MILLIS_PER_MINUTE;
  public static final long FRESH_WINDOW_MS = 60 * MILLIS_PER_MINUTE;
  public static final int SIGN_OUT_ATTEMPTS = 3;
  public static final int RESET_ATTEMPTS = 1;
  public static final int START_ATTEMPTS = 1;

  public record Account(String userId, String organizationId) {
    public static final Account NONE = new Account("", "");
    public boolean complete() { return !userId.isEmpty() && !organizationId.isEmpty(); }
  }

  public sealed interface Custody {
    record SignedOut() implements Custody {}
    record Active(int version, String credentialId, Account account, long keyExpiresAt) implements Custody {}
    record Expired(Account account) implements Custody {}
  }

  public sealed interface Attempt {
    record NoAttempt() implements Attempt {}
    record Exchanging(int attempt) implements Attempt {}
    record Acknowledging(int attempt, int version, String credentialId, Account account, long lapsesAt) implements Attempt {}
  }

  public record Duty(int version, long lapsesAt, int tries) {}

  public sealed interface Session {
    record NoSession() implements Session {}
    record Held(int version, long until, long accessExpiresAt, boolean refreshing, int waiters) implements Session {}
  }

  public static final Custody SIGNED_OUT = new Custody.SignedOut();
  public static final Attempt NO_ATTEMPT = new Attempt.NoAttempt();
  public static final Session NO_SESSION = new Session.NoSession();

  public record State(long now, int generation, int lastVersion, Custody custody, Attempt attempt, List<Duty> duties, Session session) {
    public State {
      duties = List.copyOf(duties);
    }
    State with(Custody c) { return new State(now, generation, lastVersion, c, attempt, duties, session); }
    State with(Attempt a) { return new State(now, generation, lastVersion, custody, a, duties, session); }
    State with(Session x) { return new State(now, generation, lastVersion, custody, attempt, duties, x); }
    State withDuties(List<Duty> d) { return new State(now, generation, lastVersion, custody, attempt, d, session); }
  }

  public static final State INITIAL = new State(0, 0, 0, SIGNED_OUT, NO_ATTEMPT, List.of(), NO_SESSION);

  public enum Reason {
    NO_REASON("NoReason"), GRANT_REQUIRED("GrantRequired"), UNSUPPORTED_FIELD("UnsupportedField"),
    CREDENTIAL_EXPIRED("CredentialExpired"), CREDENTIAL_REVOKED("CredentialRevoked"), CREDENTIAL_UNKNOWN("CredentialUnknown"),
    CHALLENGE_LOCKED("ChallengeLocked"), GOOGLE_ACCOUNT_CHANGED("GoogleAccountChanged"), ACCOUNT_INACTIVE("AccountInactive"),
    CAPABILITY_MISSING("CapabilityMissing"), GOOGLE_NOT_CONFIGURED("GoogleNotConfigured");
    public final String tag;
    Reason(String tag) { this.tag = tag; }
    public boolean credential() { return this == CREDENTIAL_EXPIRED || this == CREDENTIAL_REVOKED || this == CREDENTIAL_UNKNOWN; }
    public String wire() { return tag.replaceAll("(?<=[a-z0-9])(?=[A-Z])", "_").toLowerCase(java.util.Locale.ROOT); }
    public static Reason ofTag(String tag) {
      for (Reason reason : values()) if (reason.tag.equals(tag)) return reason;
      throw new IllegalArgumentException("reason " + tag);
    }
    public static Reason ofWire(String wire) {
      for (Reason reason : values()) if (reason.wire().equals(wire)) return reason;
      return NO_REASON;
    }
  }

  public enum RejectedOn { ACCOUNT_READ, OTHER_REQUEST }

  public enum Stored { WRITTEN, REMOVED, CONFLICT, CAPACITY_REFUSED, REFUSED, FAILED, UNCONFIRMED }

  public sealed interface RefreshAnswer {
    record Refreshed(long accessExpiresAt) implements RefreshAnswer {}
    record Unanswered() implements RefreshAnswer {}
    record Refused() implements RefreshAnswer {}
  }

  public sealed interface Notice {
    record Announce(int version, Account account) implements Notice {}
    record SignedOutNotice() implements Notice {}
    record ExpiredNotice() implements Notice {}
    record VerifyAccount() implements Notice {}
  }

  public record Step(State state, List<Notice> out) {
    static Step of(State state) { return new Step(state, List.of()); }
  }

  public static int attemptOf(State s) {
    if (s.attempt() instanceof Attempt.Exchanging e) return e.attempt();
    if (s.attempt() instanceof Attempt.Acknowledging k) return k.attempt();
    return 0;
  }

  public static int activeVersion(State s) {
    return s.custody() instanceof Custody.Active a ? a.version() : 0;
  }

  public static int pendingVersion(State s) {
    return s.attempt() instanceof Attempt.Acknowledging k ? k.version() : 0;
  }

  public static Account accountOf(State s) {
    if (s.custody() instanceof Custody.Active a) return a.account();
    if (s.custody() instanceof Custody.Expired e) return e.account();
    return Account.NONE;
  }

  public static boolean isSignedIn(State s) { return activeVersion(s) >= 1; }

  static List<Duty> keyDuty(Custody c, int tries) {
    return c instanceof Custody.Active a ? List.of(new Duty(a.version(), a.keyExpiresAt(), tries)) : List.of();
  }

  static List<Duty> pendingDuty(Attempt p, int tries) {
    return p instanceof Attempt.Acknowledging k ? List.of(new Duty(k.version(), k.lapsesAt(), tries)) : List.of();
  }

  private static List<Duty> concat(List<Duty> a, List<Duty> b) {
    if (b.isEmpty()) return a;
    List<Duty> out = new ArrayList<>(a);
    out.addAll(b);
    return out;
  }

  public static boolean owes(State s, int version) {
    for (Duty d : s.duties()) if (d.version() == version) return true;
    return false;
  }

  public static State beginSignIn(State s) {
    int next = s.generation() + 1;
    return new State(s.now(), next, s.lastVersion(), s.custody(), new Attempt.Exchanging(next), concat(s.duties(), pendingDuty(s.attempt(), SIGN_OUT_ATTEMPTS)), s.session());
  }

  public static boolean canTokenAnswered(State s, int attempt, String credentialId, Account account, long keyExpiresAt) {
    return s.attempt().equals(new Attempt.Exchanging(attempt)) && !credentialId.isEmpty() && account.complete() && keyExpiresAt > s.now();
  }

  public static State tokenAnswered(State s, int attempt, String credentialId, Account account, long keyExpiresAt, Stored stored) {
    if (stored != Stored.WRITTEN) return s;
    int version = s.lastVersion() + 1;
    return new State(s.now(), s.generation(), version, s.custody(),
      new Attempt.Acknowledging(attempt, version, credentialId, account, keyExpiresAt + ACK_WINDOW_MS), s.duties(), s.session());
  }

  public static boolean canAcknowledged(State s, int attempt, String credentialId, long keyExpiresAt) {
    return s.attempt() instanceof Attempt.Acknowledging k && k.attempt() == attempt && k.credentialId().equals(credentialId) && keyExpiresAt > s.now();
  }

  public static Step acknowledged(State s, int attempt, String credentialId, long keyExpiresAt) {
    if (!(s.attempt() instanceof Attempt.Acknowledging k)) return Step.of(s);
    State next = new State(s.now(), s.generation(), s.lastVersion(), new Custody.Active(k.version(), k.credentialId(), k.account(), keyExpiresAt),
      NO_ATTEMPT, concat(s.duties(), keyDuty(s.custody(), SIGN_OUT_ATTEMPTS)), NO_SESSION);
    return new Step(next, List.of(new Notice.Announce(k.version(), k.account())));
  }

  public static boolean canSignInEnded(State s, int attempt) {
    return !(s.attempt() instanceof Attempt.NoAttempt) && attemptOf(s) == attempt;
  }

  public static State signInEnded(State s, int attempt) {
    return s.with(NO_ATTEMPT).withDuties(concat(s.duties(), pendingDuty(s.attempt(), SIGN_OUT_ATTEMPTS)));
  }

  public static boolean canRejected(State s, int version, Reason reason) {
    return version >= 1 && activeVersion(s) == version && reason.credential();
  }

  public static Step rejected(State s, int version, Reason reason, RejectedOn on) {
    if (reason == Reason.CREDENTIAL_EXPIRED) return new Step(s.with(new Custody.Expired(accountOf(s))).with(NO_SESSION), List.of(new Notice.ExpiredNotice()));
    if (on == RejectedOn.ACCOUNT_READ) return new Step(s.with(SIGNED_OUT).with(NO_SESSION), List.of(new Notice.SignedOutNotice()));
    return new Step(s, List.of(new Notice.VerifyAccount()));
  }

  static Step endedBy(int tries, State s) {
    State next = new State(s.now(), s.generation() + 1, s.lastVersion(), SIGNED_OUT, NO_ATTEMPT,
      concat(concat(s.duties(), keyDuty(s.custody(), tries)), pendingDuty(s.attempt(), tries)), NO_SESSION);
    return new Step(next, s.custody() instanceof Custody.SignedOut ? List.of() : List.of(new Notice.SignedOutNotice()));
  }

  public static Step signOut(State s) { return endedBy(SIGN_OUT_ATTEMPTS, s); }

  public static Step reset(State s) { return endedBy(RESET_ATTEMPTS, s); }

  public static boolean canRevokeAnswered(State s, int version) {
    for (Duty d : s.duties()) if (d.version() == version && d.tries() > 0) return true;
    return false;
  }

  public static State revokeAnswered(State s, int version, boolean settled) {
    List<Duty> out = new ArrayList<>();
    for (Duty d : s.duties()) {
      if (settled) { if (d.version() != version) out.add(d); }
      else out.add(d.version() == version && d.tries() > 0 ? new Duty(d.version(), d.lapsesAt(), d.tries() - 1) : d);
    }
    return s.withDuties(out);
  }

  public static boolean canElapse(State s, long ms) { return ms > 0; }

  static Session sessionAt(long now, Session x) {
    return x instanceof Session.Held t && now >= t.until() ? NO_SESSION : x;
  }

  public static State elapse(State s, long ms) {
    long now = s.now() + ms;
    List<Duty> kept = new ArrayList<>();
    for (Duty d : s.duties()) if (d.lapsesAt() > now) kept.add(d);
    return new State(now, s.generation(), s.lastVersion(), s.custody(), s.attempt(), kept, sessionAt(now, s.session()));
  }

  public static State restart(State s) {
    List<Duty> duties = new ArrayList<>();
    for (Duty d : s.duties()) duties.add(new Duty(d.version(), d.lapsesAt(), START_ATTEMPTS));
    return new State(s.now(), s.generation(), s.lastVersion(), s.custody(), pendingVersion(s) >= 1 ? s.attempt() : NO_ATTEMPT, duties, NO_SESSION);
  }

  public static boolean canGrantSession(State s, Account account, long accessExpiresAt) {
    return isSignedIn(s) && accountOf(s).equals(account) && accessExpiresAt > s.now();
  }

  public static State grantSession(State s, Account account, long accessExpiresAt) {
    long until = s.now() + FRESH_WINDOW_MS;
    return s.with(new Session.Held(activeVersion(s), until, Math.min(accessExpiresAt, until), false, 0));
  }

  public static boolean canDropSession(State s) { return !(s.session() instanceof Session.NoSession); }

  public static State dropSession(State s) { return s.with(NO_SESSION); }

  public static boolean sessionUsable(State s) {
    return s.session() instanceof Session.Held t && s.now() < t.accessExpiresAt();
  }

  public static boolean canReadSession(State s) { return canDropSession(s) && !sessionUsable(s); }

  public static State readSession(State s) {
    if (!(s.session() instanceof Session.Held t)) return s;
    return s.with(t.refreshing()
      ? new Session.Held(t.version(), t.until(), t.accessExpiresAt(), true, t.waiters() + 1)
      : new Session.Held(t.version(), t.until(), t.accessExpiresAt(), true, t.waiters()));
  }

  public static boolean canRefreshAnswered(State s) { return s.session() instanceof Session.Held t && t.refreshing(); }

  public static State refreshAnswered(State s, RefreshAnswer answer) {
    if (!(s.session() instanceof Session.Held t)) return s;
    if (answer instanceof RefreshAnswer.Refreshed r) return s.with(new Session.Held(t.version(), t.until(), Math.min(r.accessExpiresAt(), t.until()), false, 0));
    if (answer instanceof RefreshAnswer.Unanswered) return s.with(new Session.Held(t.version(), t.until(), t.accessExpiresAt(), false, 0));
    return s.with(NO_SESSION);
  }

  public static String json(Account a) {
    return "{\"userId\":" + CredentialJson.quote(a.userId()) + ",\"organizationId\":" + CredentialJson.quote(a.organizationId()) + "}";
  }

  public static String json(State s) {
    String custody = "{\"tag\":\"SignedOut\"}";
    if (s.custody() instanceof Custody.Active a) custody = "{\"tag\":\"Active\",\"version\":" + a.version() + ",\"credentialId\":" + CredentialJson.quote(a.credentialId())
      + ",\"account\":" + json(a.account()) + ",\"keyExpiresAt\":" + a.keyExpiresAt() + "}";
    else if (s.custody() instanceof Custody.Expired e) custody = "{\"tag\":\"Expired\",\"account\":" + json(e.account()) + "}";
    String attempt = "{\"tag\":\"NoAttempt\"}";
    if (s.attempt() instanceof Attempt.Exchanging e) attempt = "{\"tag\":\"Exchanging\",\"attempt\":" + e.attempt() + "}";
    else if (s.attempt() instanceof Attempt.Acknowledging k) attempt = "{\"tag\":\"Acknowledging\",\"attempt\":" + k.attempt() + ",\"version\":" + k.version()
      + ",\"credentialId\":" + CredentialJson.quote(k.credentialId()) + ",\"account\":" + json(k.account()) + ",\"lapsesAt\":" + k.lapsesAt() + "}";
    StringBuilder duties = new StringBuilder("[");
    for (Duty d : s.duties()) {
      if (duties.length() > 1) duties.append(',');
      duties.append("{\"version\":").append(d.version()).append(",\"lapsesAt\":").append(d.lapsesAt()).append(",\"tries\":").append(d.tries()).append('}');
    }
    String session = s.session() instanceof Session.Held t
      ? "{\"tag\":\"Session\",\"version\":" + t.version() + ",\"until\":" + t.until() + ",\"accessExpiresAt\":" + t.accessExpiresAt()
        + ",\"refreshing\":" + t.refreshing() + ",\"waiters\":" + t.waiters() + "}"
      : "{\"tag\":\"NoSession\"}";
    return "{\"now\":" + s.now() + ",\"generation\":" + s.generation() + ",\"lastVersion\":" + s.lastVersion() + ",\"custody\":" + custody
      + ",\"attempt\":" + attempt + ",\"duties\":" + duties.append(']') + ",\"session\":" + session + "}";
  }

  public static String json(Notice n) {
    if (n instanceof Notice.Announce a) return "{\"tag\":\"Announce\",\"version\":" + a.version() + ",\"account\":" + json(a.account()) + "}";
    if (n instanceof Notice.SignedOutNotice) return "{\"tag\":\"SignedOutNotice\"}";
    if (n instanceof Notice.ExpiredNotice) return "{\"tag\":\"ExpiredNotice\"}";
    return "{\"tag\":\"VerifyAccount\"}";
  }

  public static Account account(Object raw) {
    Map<String, Object> a = CredentialJson.object(raw, "account");
    return new Account(CredentialJson.text(a, "userId"), CredentialJson.text(a, "organizationId"));
  }

  public static State state(Object raw) {
    Map<String, Object> s = CredentialJson.object(raw, "state");
    Map<String, Object> c = CredentialJson.object(s.get("custody"), "custody");
    Custody custody = switch (CredentialJson.text(c, "tag")) {
      case "SignedOut" -> SIGNED_OUT;
      case "Active" -> new Custody.Active(CredentialJson.small(c, "version"), CredentialJson.text(c, "credentialId"), account(c.get("account")), CredentialJson.whole(c, "keyExpiresAt"));
      case "Expired" -> new Custody.Expired(account(c.get("account")));
      default -> throw new CredentialJson.Malformed("custody");
    };
    Map<String, Object> p = CredentialJson.object(s.get("attempt"), "attempt");
    Attempt attempt = switch (CredentialJson.text(p, "tag")) {
      case "NoAttempt" -> NO_ATTEMPT;
      case "Exchanging" -> new Attempt.Exchanging(CredentialJson.small(p, "attempt"));
      case "Acknowledging" -> new Attempt.Acknowledging(CredentialJson.small(p, "attempt"), CredentialJson.small(p, "version"),
        CredentialJson.text(p, "credentialId"), account(p.get("account")), CredentialJson.whole(p, "lapsesAt"));
      default -> throw new CredentialJson.Malformed("attempt");
    };
    List<Duty> duties = new ArrayList<>();
    for (Object row : CredentialJson.list(s.get("duties"), "duties")) {
      Map<String, Object> d = CredentialJson.object(row, "duty");
      duties.add(new Duty(CredentialJson.small(d, "version"), CredentialJson.whole(d, "lapsesAt"), CredentialJson.small(d, "tries")));
    }
    Map<String, Object> x = CredentialJson.object(s.get("session"), "session");
    Session session = switch (CredentialJson.text(x, "tag")) {
      case "NoSession" -> NO_SESSION;
      case "Session" -> new Session.Held(CredentialJson.small(x, "version"), CredentialJson.whole(x, "until"), CredentialJson.whole(x, "accessExpiresAt"),
        CredentialJson.flag(x, "refreshing"), CredentialJson.small(x, "waiters"));
      default -> throw new CredentialJson.Malformed("session");
    };
    State parsed = new State(CredentialJson.whole(s, "now"), CredentialJson.small(s, "generation"), CredentialJson.small(s, "lastVersion"), custody, attempt, duties, session);
    if (!holds(parsed)) throw new CredentialJson.Malformed("state breaks its rules");
    return parsed;
  }

  public static boolean holds(State s) {
    if (s.now() < 0 || s.generation() < 0 || s.lastVersion() < 0) return false;
    if (!(s.attempt() instanceof Attempt.NoAttempt) && !(attemptOf(s) == s.generation() && s.generation() >= 1)) return false;
    if (s.custody() instanceof Custody.Active a && (a.version() < 1 || a.version() > s.lastVersion())) return false;
    if (s.attempt() instanceof Attempt.Acknowledging k && (k.version() < 1 || k.version() != s.lastVersion() || activeVersion(s) >= k.version())) return false;
    for (Duty d : s.duties()) {
      if (d.version() < 1 || d.version() > s.lastVersion() || d.tries() < 0 || d.tries() > SIGN_OUT_ATTEMPTS
        || d.version() == activeVersion(s) || d.version() == pendingVersion(s)) return false;
    }
    if (s.session() instanceof Session.Held t) {
      if (!(t.version() >= 1 && t.version() == activeVersion(s) && s.now() < t.until() && t.until() <= s.now() + FRESH_WINDOW_MS && t.accessExpiresAt() <= t.until())) return false;
      if (t.waiters() < 0 || (t.waiters() >= 1 && !t.refreshing())) return false;
    }
    return true;
  }
}
