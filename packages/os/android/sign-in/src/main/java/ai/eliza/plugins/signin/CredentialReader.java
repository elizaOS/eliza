// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.Notice;

public interface CredentialReader {
  record Credential(int version, String credentialId, String value, Account account, long keyExpiresAt) {
    @Override public String toString() {
      return "Credential[version=" + version + ", credentialId=" + credentialId + ", account=" + account + ", keyExpiresAt=" + keyExpiresAt + "]";
    }
  }

  interface Listener {
    void notice(Notice notice);
  }

  interface Subscription extends AutoCloseable {
    @Override void close();
  }

  Credential current();

  Account account();

  Subscription listen(Listener listener);

  void report401(int version, String reason);
}
