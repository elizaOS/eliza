// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.SignInPolicy.Failure;

public interface SignInCustody {
  record Proof(String code, String state, String verifier) {}

  record Account(String userId, String organizationId) {}

  record Held(int version, String credentialId, String key, Account account, long keyExpiresAt) {}

  record Session(Account account, String accessToken, String refreshToken, long accessExpiresAt) {}

  final class Refused extends Exception {
    public final Failure failure;
    public Refused(Failure failure) { super(failure.wire, null, false, false); this.failure = failure; }
  }

  int beginSignIn();

  void signInEnded(int attempt);

  Proof connect(int attempt, SignInRegistration.Environment environment, String accessToken) throws Refused;

  String redeem(int attempt, SignInRegistration.Environment environment, Proof proof, String mintedAnswer) throws Refused;

  Held held();

  boolean grantSession(Session session);

  void signOut();
}
