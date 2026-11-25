// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.MailLeaseUpgrade;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInRegistration.Environment;

public interface SignInCustody {
  record Proof(String code, String state, String verifier) {
    @Override public String toString() { return "Proof[redacted]"; }
  }

  record Held(int version, String credentialId, String key, Account account, long keyExpiresAt) {
    @Override public String toString() { return "Held[version=" + version + ", credentialId=" + credentialId + ", account=" + account + "]"; }
  }

  record Session(Account account, String accessToken, String refreshToken, long accessExpiresAt) {
    @Override public String toString() { return "Session[account=" + account + ", accessExpiresAt=" + accessExpiresAt + "]"; }
  }

  final class Refused extends Exception {
    public final Failure failure;
    public Refused(Failure failure) { super(failure.wire, null, false, false); this.failure = failure; }
  }

  int beginSignIn(Environment environment) throws Refused;

  default MailLeaseUpgrade mailLeaseUpgrade(Environment environment) { return null; }

  default int beginMailLeaseUpgrade(Environment environment, MailLeaseUpgrade expected) throws Refused {
    throw new Refused(Failure.REJECTED);
  }

  void signInEnded(Environment environment, int attempt);

  Proof connect(int attempt, Environment environment, String accessToken) throws Refused;

  String redeem(int attempt, Environment environment, Proof proof) throws Refused;

  Held held(Environment environment);

  boolean grantSession(Environment environment, Session session);

  void signOut(Environment environment);
}
