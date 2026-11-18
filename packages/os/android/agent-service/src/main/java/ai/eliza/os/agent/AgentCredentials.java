// spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"
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

  AgentCredentials NONE = new AgentCredentials() {
    @Override public Active current() { return null; }
    @Override public String storageKey(Account account) { return null; }
  };

  Active current() throws Exception;

  String storageKey(Account account) throws Exception;
}
