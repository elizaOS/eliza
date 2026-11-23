// spec/os/agentService/config.md, "Only a cloud launch is handed the mail and calendar broker, by its address and bearer, never a credential"
package ai.eliza.os.agent;

import java.io.IOException;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Pattern;

public interface GoogleBroker {
  Pattern BEARER = Pattern.compile("[A-Za-z0-9_-]{64}");

  record Endpoint(int port, String bearer) {
    public Endpoint {
      if (port < 1024 || port > 65535 || bearer == null || !BEARER.matcher(bearer).matches())
        throw new IllegalArgumentException("A broker endpoint needs an unprivileged loopback port and a 64 character bearer");
    }

    public String url() { return "http://127.0.0.1:" + port + "/__alpha-owner-gmail"; }

    public Map<String, String> environment() {
      return Map.of("ELIZA_MANAGED_GMAIL_READ_BROKER", url(), "ELIZA_MANAGED_CALENDAR_READ_BROKER", url(), "ELIZA_API_TOKEN", bearer);
    }

    @Override public String toString() { return "GoogleBroker.Endpoint(" + port + ")"; }
  }

  Endpoint open() throws IOException;

  /** The process environment a launch is handed: the broker's address and bearer for a cloud launch whose broker opened, and nothing otherwise. */
  static Map<String, String> launchEnvironment(boolean needsAccount, GoogleBroker broker, Consumer<Exception> unavailable) {
    if (!needsAccount || broker == null) return Map.of();
    try {
      return broker.open().environment();
    } catch (IOException | RuntimeException failed) {
      unavailable.accept(failed);
      return Map.of();
    }
  }
}
