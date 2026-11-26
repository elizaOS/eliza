// spec/os/android/taskKeys.md, "Story: Keep each account's tasks under its own key"; spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.plugins.securestore.nativeonly.TaskKeyCustody;
import java.util.function.Consumer;

final class DeviceAgentCredentials implements AgentCredentials {
  private final CredentialReader reader;
  private final TaskKeyCustody taskKeys;
  private final Consumer<TaskKeyCustody.ReleaseRefused> refused;
  private final Object following = new Object();

  DeviceAgentCredentials(CredentialReader reader, TaskKeyCustody taskKeys, Consumer<TaskKeyCustody.ReleaseRefused> refused) {
    this.reader = reader;
    this.taskKeys = taskKeys;
    this.refused = refused;
    reader.listen(notice -> verify());
    verify();
  }

  // The account is read and custody stepped under one lock, so a verify that read an account before a sign-out
  // cannot apply it after the listener's verify applied the sign-out.
  private void verify() {
    synchronized (following) {
      CredentialPolicy.Account held = reader.account();
      TaskKeyCustody.Account named = held.complete() ? custodyAccount(held.userId(), held.organizationId()) : null;
      if (named != null) taskKeys.accountVerified(named);
      else taskKeys.signedOut();
    }
  }

  private static TaskKeyCustody.Account custodyAccount(String userId, String organizationId) {
    try {
      return new TaskKeyCustody.Account(userId, organizationId);
    } catch (IllegalArgumentException unnamed) {
      return null;
    }
  }

  @Override public Active current() {
    CredentialReader.Credential credential = reader.current();
    if (credential == null || !credential.account().complete()) return null;
    return new Active(credential.version(), credential.value(), credential.keyExpiresAt(),
      new Account(credential.account().userId(), credential.account().organizationId()));
  }

  @Override public StorageKey storageKey(Account account, long epoch) {
    verify();
    TaskKeyCustody.StorageKey released;
    try {
      TaskKeyCustody.Account named = custodyAccount(account.userId(), account.organizationId());
      if (named == null) throw new TaskKeyCustody.ReleaseRefused(TaskKeyCustody.Refusal.NotVerifiedAccount, null);
      released = taskKeys.releaseForLaunch(named, epoch);
    } catch (TaskKeyCustody.ReleaseRefused refusal) {
      refused.accept(refusal);
      return null;
    }
    return new StorageKey() {
      @Override public String value() {
        try {
          return released.value();
        } catch (IllegalStateException retired) {
          return null;
        }
      }
      @Override public void close() { released.close(); }
    };
  }
}
