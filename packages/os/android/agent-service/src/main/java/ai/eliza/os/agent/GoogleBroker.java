// spec/os/agentService/config.md, "Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential"
package ai.eliza.os.agent;

import java.io.IOException;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

public interface GoogleBroker extends AutoCloseable {
  String PATH = "/__owner-gmail";
  String ENDPOINT_VARIABLE = "ELIZA_MANAGED_GMAIL_READ_BROKER";
  String BEARER_VARIABLE = "ELIZA_MANAGED_GMAIL_READ_BROKER_TOKEN";
  Pattern BEARER = Pattern.compile("[A-Za-z0-9_-]{64}");

  record Endpoint(int port, String bearer) {
    public Endpoint {
      if (port < 1024 || port > 65535 || bearer == null || !BEARER.matcher(bearer).matches())
        throw new IllegalArgumentException("A broker endpoint needs an unprivileged loopback port and a 64 character bearer");
    }

    public String url() { return "http://127.0.0.1:" + port + PATH; }

    public Map<String, String> environment() { return Map.of(ENDPOINT_VARIABLE, url(), BEARER_VARIABLE, bearer); }

    @Override public String toString() { return "GoogleBroker.Endpoint(" + port + ")"; }
  }

  Endpoint open(AgentCredentials.Account owner) throws IOException;

  void revoke(Endpoint launched);

  void revoke();

  @Override void close() throws IOException;

  static Endpoint forLaunch(boolean needsAccount, AgentCredentials.Account owner, GoogleBroker broker, Consumer<Exception> unavailable) {
    if (broker == null) return null;
    if (needsAccount && owner != null) {
      try {
        return broker.open(owner);
      } catch (IOException | RuntimeException failed) {
        unavailable.accept(failed);
      }
    }
    broker.revoke();
    return null;
  }
}
