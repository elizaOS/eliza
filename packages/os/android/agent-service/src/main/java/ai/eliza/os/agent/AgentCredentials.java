// spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"; spec/os/agentService/config.md, "Only a cloud launch is framed with the device key, and an own-key launch with the owner's provider key or none"; spec/os/android/taskKeys.md, "The current account's key is released only as the storage key of a launch newer than every earlier one"
package ai.eliza.os.agent;

public interface AgentCredentials {
  record Account(String userId, String organizationId) {
    public Account {
      if (userId == null || userId.isEmpty() || organizationId == null || organizationId.isEmpty())
        throw new IllegalArgumentException("An account needs a user and an organization");
    }
  }

  record Active(long version, String value, long expiresAt, Account account) {
    public Active {
      if (version < 1 || value == null || value.isEmpty() || account == null) throw new IllegalArgumentException("Invalid device credential");
    }
    @Override public String toString() { return "AgentCredentials.Active(" + version + ")"; }
  }

  interface StorageKey extends AutoCloseable {
    String value();
    @Override void close();
  }

  AgentCredentials NONE = new AgentCredentials() {
    @Override public Active current() { return null; }
    @Override public StorageKey storageKey(Account account, long epoch) { return null; }
  };

  Active current() throws Exception;

  StorageKey storageKey(Account account, long epoch) throws Exception;

  default LaunchFrame.Credential providerKey() throws Exception { return null; }
}
