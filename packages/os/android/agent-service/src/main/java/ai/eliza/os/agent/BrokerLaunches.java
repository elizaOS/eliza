// spec/os/agentService/config.md, "Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential"
package ai.eliza.os.agent;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;

public final class BrokerLaunches {
  private final Consumer<Exception> closeFailed;
  private final Set<Launch> holding = new HashSet<>();
  private GoogleBroker installed;

  public BrokerLaunches(Consumer<Exception> closeFailed) { this.closeFailed = closeFailed; }

  public final class Launch {
    private final Runnable relaunch;
    private GoogleBroker broker;
    private GoogleBroker.Endpoint endpoint;
    private boolean ended;

    private Launch(Runnable relaunch) { this.relaunch = relaunch; }

    public GoogleBroker.Endpoint open(boolean needsAccount, AgentCredentials.Account owner, Consumer<Exception> unavailable) {
      GoogleBroker retired;
      GoogleBroker.Endpoint opened;
      synchronized (BrokerLaunches.this) {
        retired = release();
        opened = ended ? null : GoogleBroker.forLaunch(needsAccount, owner, installed, unavailable);
        if (opened != null) {
          broker = installed;
          endpoint = opened;
          holding.add(this);
        }
      }
      close(retired);
      return opened;
    }

    public void revoke() {
      GoogleBroker retired;
      synchronized (BrokerLaunches.this) { retired = release(); }
      close(retired);
    }

    public void end() {
      GoogleBroker retired;
      synchronized (BrokerLaunches.this) {
        ended = true;
        retired = release();
      }
      close(retired);
    }

    public boolean replaced() {
      synchronized (BrokerLaunches.this) { return broker != null && broker != installed; }
    }

    private GoogleBroker release() {
      GoogleBroker held = broker;
      if (held == null) return null;
      held.revoke(endpoint);
      broker = null;
      endpoint = null;
      holding.remove(this);
      return held != installed && holding.stream().noneMatch(other -> other.broker == held) ? held : null;
    }
  }

  public Launch launch(Runnable relaunch) { return new Launch(Objects.requireNonNull(relaunch)); }

  public void install(GoogleBroker broker) {
    Objects.requireNonNull(broker);
    GoogleBroker replaced;
    List<Launch> held;
    synchronized (this) {
      replaced = installed;
      if (replaced == broker) return;
      installed = broker;
      held = holding.stream().filter(launch -> launch.broker == replaced).toList();
    }
    if (held.isEmpty()) close(replaced);
    for (Launch launch : held) launch.relaunch.run();
  }

  private void close(GoogleBroker retired) {
    if (retired == null) return;
    try { retired.close(); }
    catch (IOException | RuntimeException failed) { closeFailed.accept(failed); }
  }
}
