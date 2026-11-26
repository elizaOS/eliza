// spec/os/android/taskKeys.md, "Story: Keep each account's tasks under its own key"; spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.plugins.securestore.nativeonly.TaskKeyCustody;
import java.util.function.Consumer;

final class DeviceAgentCredentials implements AgentCredentials {
  private final CredentialReader reader;
  private final TaskKeyCustody taskKeys;
  private final Consumer<TaskKeyCustody.ReleaseRefused> refused;

  DeviceAgentCredentials(CredentialReader reader, TaskKeyCustody taskKeys, Consumer<TaskKeyCustody.ReleaseRefused> refused) {
    this.reader = reader;
    this.taskKeys = taskKeys;
    this.refused = refused;
    reader.listen(notice -> verify());
    verify();
  }

  private void verify() {
    CredentialPolicy.Account held = reader.account();
    if (held.complete()) taskKeys.accountVerified(new TaskKeyCustody.Account(held.userId(), held.organizationId()));
    else taskKeys.signedOut();
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
      released = taskKeys.releaseForLaunch(new TaskKeyCustody.Account(account.userId(), account.organizationId()), epoch);
    } catch (TaskKeyCustody.ReleaseRefused refusal) {
      refused.accept(refusal);
      return null;
    }
    return new StorageKey() {
      @Override public String value() { return released.value(); }
      @Override public void close() { released.close(); }
    };
  }
}
