// spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"; spec/os/agentService/config.md, "Only a cloud launch is framed with the device key, and an own-key launch with the owner's provider key or none"; spec/os/agentService/residentBinding.md, "The resident launch needs its own readable vault, even without inference"
package ai.eliza.os.agent;

import java.net.URI;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import java.util.Objects;

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

  record VerifiedCloud(String origin, Active credential) {
    public VerifiedCloud {
      origin = canonicalOrigin(origin);
      Objects.requireNonNull(credential);
    }
    @Override public String toString() { return "AgentCredentials.VerifiedCloud(" + credential.version() + ")"; }
  }

  record ResidentState(AgentConfig.ResidentOwner owner, String storageKey, String linkedOrigin, VerifiedCloud cloud, LaunchFrame.Credential ownKey) {
    public ResidentState {
      Objects.requireNonNull(owner);
      if ((owner.linkedAccount() == null) != (linkedOrigin == null)) throw new IllegalArgumentException("A resident's Cloud link needs its origin and account");
      if (linkedOrigin != null) linkedOrigin = canonicalOrigin(linkedOrigin);
      if (!canonicalStorageKey(storageKey)) throw new IllegalArgumentException("A resident needs its available 32-byte storage key");
    }
    @Override public String toString() { return "AgentCredentials.ResidentState"; }
  }

  static String canonicalOrigin(String origin) {
    URI parsed = URI.create(Objects.requireNonNull(origin));
    int port = parsed.getPort();
    if (!"https".equalsIgnoreCase(parsed.getScheme()) || parsed.getHost() == null || !parsed.getRawPath().isEmpty()
        || parsed.getRawUserInfo() != null || parsed.getRawQuery() != null || parsed.getRawFragment() != null || port == 0 || port > 65535)
      throw new IllegalArgumentException("A resident's Cloud link needs an HTTPS origin");
    return "https://" + parsed.getHost().toLowerCase(Locale.ROOT) + (port < 0 || port == 443 ? "" : ":" + port);
  }

  private static boolean canonicalStorageKey(String encoded) {
    if (encoded == null || encoded.length() < 43 || encoded.length() > 44) return false;
    byte[] bytes;
    try { bytes = (encoded.length() == 43 ? Base64.getUrlDecoder() : Base64.getDecoder()).decode(encoded); }
    catch (IllegalArgumentException unreadable) { return false; }
    try {
      return bytes.length == 32 && (encoded.length() == 43 ? Base64.getUrlEncoder().withoutPadding() : Base64.getEncoder()).encodeToString(bytes).equals(encoded);
    } finally { Arrays.fill(bytes, (byte) 0); }
  }

  AgentCredentials NONE = new AgentCredentials() {
    @Override public Active current() { return null; }
    @Override public String storageKey(Account account) { return null; }
  };

  Active current() throws Exception;

  String storageKey(Account account) throws Exception;

  default LaunchFrame.Credential providerKey() throws Exception { return null; }

  default ResidentState residentState() throws Exception { return null; }
}
