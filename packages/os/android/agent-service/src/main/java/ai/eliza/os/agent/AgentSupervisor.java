// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/lifecycle.md, "Story: Restart a crashed or unhealthy agent within a budget"
package ai.eliza.os.agent;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.concurrent.TimeUnit;

final class AgentSupervisor {
  static final long READY_POLL_MS = 1_000L;
  static final long STOP_GRACE_MS = 5_000L;
  static final long LOG_BYTES = 1024 * 1024;
  static final String AGENT_SCRIPT = "agent.mjs";

  record Command(Path node, Path bundleDir, Path launchDocument, Path stateDir, Path socket, Path log) {
    ProcessBuilder builder() throws IOException {
      Path tmp = stateDir.resolve("tmp");
      Files.createDirectories(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
      ProcessBuilder builder = new ProcessBuilder(List.of(node.toAbsolutePath().toString(),
        bundleDir.resolve(AGENT_SCRIPT).toAbsolutePath().toString(), "serve",
        "--launch", launchDocument.toAbsolutePath().toString(),
        "--state", stateDir.toAbsolutePath().toString(),
        "--socket", socket.toAbsolutePath().toString())).directory(bundleDir.toFile());
      var environment = builder.environment();
      environment.clear();
      environment.put("PATH", "/system/bin");
      environment.put("HOME", stateDir.toAbsolutePath().toString());
      environment.put("TMPDIR", tmp.toAbsolutePath().toString());
      return builder;
    }
  }

  @FunctionalInterface interface Readiness { boolean ready(long epoch) throws Exception; }
  @FunctionalInterface interface Journal { void spawned(long epoch, long pid) throws IOException; }

  interface Listener {
    void ready(long epoch);
    void readinessTimedOut(long epoch);
    void exited(long epoch, int code);
  }

  static final class Child {
    final long epoch;
    final long pid;
    private final Process process;
    private volatile boolean stopping;
    private Child(long epoch, long pid, Process process) { this.epoch = epoch; this.pid = pid; this.process = process; }
    boolean alive() { return process.isAlive(); }
    boolean stopping() { return stopping; }

    void stop() {
      stopping = true;
      process.destroy();
      try { if (process.waitFor(STOP_GRACE_MS, TimeUnit.MILLISECONDS)) return; }
      catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
      process.destroyForcibly();
    }

    void kill() { stopping = true; process.destroyForcibly(); }
  }

  private AgentSupervisor() {}

  static Child spawn(long epoch, Command command, byte[] frame, Journal journal, Readiness readiness, Listener listener) throws IOException {
    Files.deleteIfExists(command.socket());
    rotate(command.log());
    ProcessBuilder builder = command.builder().redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(command.log().toFile()));
    Process process = builder.start();
    Child child;
    try {
      child = new Child(epoch, process.pid(), process);
      journal.spawned(epoch, child.pid);
      try (OutputStream input = process.getOutputStream()) { input.write(frame); }
    } catch (IOException | RuntimeException failed) {
      process.destroyForcibly();
      throw failed;
    }
    Thread exit = new Thread(() -> {
      int code;
      while (true) {
        try { code = process.waitFor(); break; }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
      }
      listener.exited(epoch, code);
    }, "ElizaAgentExit");
    exit.setDaemon(true);
    exit.start();
    Thread ready = new Thread(() -> awaitReady(child, readiness, listener), "ElizaAgentReady");
    ready.setDaemon(true);
    ready.start();
    return child;
  }

  private static void awaitReady(Child child, Readiness readiness, Listener listener) {
    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(AgentPolicy.READY_TIMEOUT_MS);
    while (child.alive() && !child.stopping()) {
      boolean ready = false;
      try { ready = readiness.ready(child.epoch); }
      catch (Exception notYet) { ready = false; }
      if (!child.alive() || child.stopping()) return;
      if (ready) { listener.ready(child.epoch); return; }
      long remaining = deadline - System.nanoTime();
      if (remaining <= 0) { listener.readinessTimedOut(child.epoch); return; }
      try { TimeUnit.NANOSECONDS.sleep(Math.min(remaining, TimeUnit.MILLISECONDS.toNanos(READY_POLL_MS))); }
      catch (InterruptedException interrupted) { return; }
    }
  }

  private static void rotate(Path log) throws IOException {
    File file = log.toFile();
    if (Files.isRegularFile(log, LinkOption.NOFOLLOW_LINKS) && file.length() > LOG_BYTES)
      Files.move(log, log.resolveSibling(log.getFileName() + ".1"), StandardCopyOption.REPLACE_EXISTING);
  }
}
