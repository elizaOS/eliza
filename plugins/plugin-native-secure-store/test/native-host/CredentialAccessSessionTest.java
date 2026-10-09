import ai.eliza.plugins.securestore.nativeonly.CredentialAccessSession;

/** Deterministic elapsed-time tests: no device credentials, Android stubs or wall-clock sleeps. */
public final class CredentialAccessSessionTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  public static void main(String[] args) {
    long[] now = {100};
    CredentialAccessSession session = new CredentialAccessSession(() -> now[0], 110000);
    check(!session.authenticated());
    long first = session.begin();
    check(first > 0 && session.pending());
    check(session.begin() == 0);
    check(!session.complete(first + 1, true) && session.pending());
    session.stop(); // The Android challenge is in front; there is no authority yet.
    check(session.pending() && !session.authenticated());
    check(session.complete(first, true));
    check(session.authenticated() && session.remainingMillis() == 110000);
    now[0] += 109999;
    check(session.authenticated() && session.remainingMillis() == 1);
    check(!session.complete(first, true)); // Duplicate result cannot extend the grant.
    now[0]++;
    check(!session.authenticated()); // Enforced without waiting for Handler delivery.
    long second = session.begin();
    check(second > first && session.complete(second, true));
    session.stop();
    check(!session.authenticated());
    long abandoned = session.begin();
    session.lock();
    long replacement = session.begin();
    check(!session.complete(abandoned, true) && session.pending());
    check(session.complete(replacement, true));
    check(!session.complete(abandoned, false) && session.authenticated());
    long rejected = session.begin();
    check(!session.authenticated());
    check(!session.complete(rejected, false) && !session.pending());
    long backward = session.begin();
    check(session.complete(backward, true));
    now[0]--;
    check(!session.authenticated());
    now[0] = Long.MAX_VALUE - 5;
    long nearLimit = session.begin();
    check(session.complete(nearLimit, true) && session.remainingMillis() == 110000);
    now[0] = Long.MAX_VALUE;
    check(session.remainingMillis() == 109995);
    now[0] = -1;
    check(!session.authenticated());
    check(!session.complete(session.begin(), true));
    now[0] = 200;
    long closing = session.begin();
    session.close();
    check(!session.complete(closing, true) && session.begin() == 0 && !session.pending());
    session.stop(); session.lock();
    check(!session.authenticated());
    try { new CredentialAccessSession(() -> 0, 0); throw new AssertionError(); }
    catch (IllegalArgumentException expected) { checks++; }
    try { new CredentialAccessSession(null, 1); throw new AssertionError(); }
    catch (IllegalArgumentException expected) { checks++; }
    System.out.println("CredentialAccessSession: " + checks + " assertions passed");
  }
}
