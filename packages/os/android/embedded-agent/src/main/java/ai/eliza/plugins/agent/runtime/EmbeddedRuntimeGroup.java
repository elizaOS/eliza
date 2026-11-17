package ai.eliza.plugins.agent.runtime;

import java.io.IOException;
import java.util.List;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicLong;

public final class EmbeddedRuntimeGroup {
  private static final AtomicLong EPOCHS = new AtomicLong();

  public static final class Endpoint {
    public final Path socket;
    public final String token;
    public final long epoch;
    private Endpoint(Path socket, String token, long epoch) {
      this.socket = socket;
      this.token = token;
      this.epoch = epoch;
    }
  }
  public record Launch(ProcessBuilder command, byte[] frame, List<String> redactions) {
    @Override public String toString() { return "EmbeddedRuntimeGroup.Launch"; }
  }
  @FunctionalInterface public interface AgentCommand { Launch create(Endpoint endpoint) throws Exception; }
  @FunctionalInterface public interface Readiness { boolean ready(Endpoint endpoint) throws Exception; }
  private final NativeProcessLog log;
  private final Readiness readiness;
  private final long budget, poll;
  private volatile Endpoint endpoint;

  public EmbeddedRuntimeGroup(NativeProcessLog log, Readiness readiness, long budget, long poll) {
    if (log == null || readiness == null || budget < 1 || budget > 86_400_000 || poll < 1 || poll > budget)
      throw new IllegalArgumentException("Invalid embedded runtime group policy");
    this.log = log;
    this.readiness = readiness;
    this.budget = budget;
    this.poll = poll;
  }

  public Endpoint agent() { return endpoint; }
  public Endpoint served() { return endpoint; }

  public void launchAgent(NativeRuntimeSession.Scope scope, Path directory, AgentCommand command) throws Exception {
    scope.check();
    long epoch = EPOCHS.incrementAndGet();
    Path socket = directory.resolve("s-" + epoch + ".sock");
    Files.deleteIfExists(socket);
    Endpoint selected = new Endpoint(socket, EmbeddedRuntimeLaunch.token(), epoch);
    scope.onClose(() -> { try { Files.deleteIfExists(socket); } catch (IOException unavailable) { } });
    endpoint = selected;
    try {
      Launch launch = command.create(selected);
      Process child = scope.start("agent", launch.command(), log, launch.redactions());
      try (var input = child.getOutputStream()) { input.write(launch.frame()); }
      scope.awaitReady(child, () -> readiness.ready(selected), budget, poll);
    } catch (IOException failure) {
      throw new RuntimeStartFailure(RuntimeStartFailure.Cause.AGENT, failure.getMessage(), failure);
    }
  }
}
