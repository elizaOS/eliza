// spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"; spec/agent/host/launch.md, "Only the epoch and the credential version of a frame may be shown, never the token, the credential or the storage key"
package ai.eliza.os.agent;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

public final class LaunchFrame {
  public static final int VERSION = 1;
  private static final SecureRandom RANDOM = new SecureRandom();

  public record Credential(long version, String value) {
    public Credential {
      if (version < 1 || !AgentConfig.nonblank(value)) throw new IllegalArgumentException("A launch credential needs a positive version and a value");
    }
    public static Credential of(AgentCredentials.Active active) { return active == null ? null : new Credential(active.version(), active.value()); }
    @Override public String toString() { return "LaunchFrame.Credential(" + version + ")"; }
  }

  public final long epoch;
  private final String token, storageKey;
  private final Credential credential;

  private LaunchFrame(String token, long epoch, Credential credential, String storageKey) {
    if (!AgentConfig.nonblank(token) || epoch < 1 || (storageKey != null && !AgentConfig.nonblank(storageKey)))
      throw new IllegalArgumentException("A launch frame needs a token, a positive epoch and a nonblank storage key when it has one");
    this.token = token;
    this.epoch = epoch;
    this.credential = credential;
    this.storageKey = storageKey;
  }

  public static LaunchFrame first(String token, long epoch, Credential credential, String storageKey) {
    return new LaunchFrame(token, epoch, credential, storageKey);
  }

  public LaunchFrame next(String token, Credential credential, String storageKey) {
    if (credential != null && credential.version() < credentialVersion())
      throw new IllegalArgumentException("A later launch never names an older credential version");
    return new LaunchFrame(token, epoch + 1, credential, storageKey);
  }

  public static String newToken() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  public long credentialVersion() { return credential == null ? 0 : credential.version(); }

  public boolean accepts(Credential pushed) { return pushed != null && pushed.version() > credentialVersion(); }

  public boolean holdsToken(String presented) {
    return presented != null && java.security.MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), presented.getBytes(StandardCharsets.UTF_8));
  }

  public byte[] encode() {
    Map<String, Object> frame = new LinkedHashMap<>();
    frame.put("version", BigDecimal.valueOf(VERSION));
    frame.put("token", token);
    frame.put("epoch", BigDecimal.valueOf(epoch));
    if (credential != null) {
      Map<String, Object> held = new LinkedHashMap<>();
      held.put("version", BigDecimal.valueOf(credential.version()));
      held.put("value", credential.value());
      frame.put("credential", held);
    }
    if (storageKey != null) frame.put("storageKey", storageKey);
    return (AgentConfig.json(frame) + "\n").getBytes(StandardCharsets.UTF_8);
  }

  @Override public String toString() { return "LaunchFrame(epoch=" + epoch + ", credentialVersion=" + credentialVersion() + ")"; }
}
