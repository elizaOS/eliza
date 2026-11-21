// spec/os/appUpdate/health.md, "The agent half is the agent service's verdict for the current launch, and storage counts only from a ready agent"; spec/os/agentService/health.md, "A probe is Ok only for a ready answer of the current launch"
package ai.eliza.plugins.agent.health.contract;

import ai.eliza.plugins.agent.health.HealthWork.Agent;
import ai.eliza.plugins.agent.health.HealthWork.Storage;
import ai.eliza.plugins.agent.health.LocalRuntimeHealth;
import ai.eliza.plugins.agent.health.LocalRuntimeHealth.Launch;
import ai.eliza.plugins.agent.health.LocalRuntimeHealth.Reading;
import ai.eliza.plugins.agent.health.LocalRuntimeHealth.Reply;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public final class LocalRuntimeHealthContract {
  private LocalRuntimeHealthContract() {}

  private static final class Agent0 implements LocalRuntimeHealth.AgentPort {
    Optional<Launch> launch = Optional.empty();
    Reply health = ready(1), storage = new Reply(200, "{\"schemaVersion\":1,\"taskStorage\":\"ok\"}");
    boolean silent, alive, accepts;
    final List<String> routes = new ArrayList<>();
    @Override public Optional<Launch> launch() { return launch; }
    @Override public Reply get(long epoch, String route, long timeoutMillis) throws IOException {
      check(timeoutMillis == 321, "Probe budget not passed through");
      check(launch.isPresent() && launch.get().epoch == epoch, "Request sent for another launch");
      routes.add(route);
      if (silent) throw new IOException("no answer");
      if (route.equals(LocalRuntimeHealth.HEALTH_ROUTE)) return health;
      check(route.equals(LocalRuntimeHealth.STORAGE_ROUTE), "Unexpected route " + route);
      return storage;
    }
    @Override public boolean childAlive(long epoch) { return alive; }
    @Override public boolean socketAccepts(long epoch) { return accepts; }
  }

  private static Reply ready(long epoch) {
    return new Reply(200, "{\"ready\":true,\"runtime\":\"ok\",\"agentState\":\"running\",\"epoch\":" + epoch + "}");
  }

  private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }

  private static void expect(Reading reading, Agent agent, Storage storage, String message) {
    check(reading.agent == agent && reading.storage == storage, message + ": " + reading.agent + "/" + reading.storage);
  }

  public static void run() {
    Agent0 port = new Agent0();
    LocalRuntimeHealth health = new LocalRuntimeHealth(port);
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "No launch must wait");
    check(port.routes.isEmpty(), "No launch must send nothing");

    port.launch = Optional.of(new Launch(1, 0, 0, true));
    Reading healthy = health.read(321);
    expect(healthy, Agent.HEALTHY, Storage.OK, "Ready agent with ok storage");
    check(port.routes.equals(List.of(LocalRuntimeHealth.HEALTH_ROUTE, LocalRuntimeHealth.STORAGE_ROUTE)), "Health then storage");
    check(health.sameLaunch(healthy), "Same launch");

    port.storage = new Reply(200, "{\"schemaVersion\":1,\"taskStorage\":\"deferred\"}");
    expect(health.read(321), Agent.HEALTHY, Storage.DEFERRED, "Deferred storage");
    port.storage = new Reply(200, "{\"schemaVersion\":2,\"taskStorage\":\"ok\"}");
    expect(health.read(321), Agent.HEALTHY, Storage.UNAVAILABLE, "Unknown storage schema");
    port.storage = new Reply(503, "{\"schemaVersion\":1,\"taskStorage\":\"ok\"}");
    expect(health.read(321), Agent.HEALTHY, Storage.UNAVAILABLE, "Refused storage probe");
    port.storage = new Reply(200, "{\"schemaVersion\":1,\"taskStorage\":\"invented\"}");
    expect(health.read(321), Agent.HEALTHY, Storage.UNAVAILABLE, "Unknown storage value");

    port.launch = Optional.of(new Launch(1, 0, 0, false));
    port.routes.clear();
    expect(health.read(321), Agent.HEALTHY, Storage.NOT_LOADED, "Tasks not loaded");
    check(port.routes.equals(List.of(LocalRuntimeHealth.HEALTH_ROUTE)), "No storage probe without tasks");

    port.launch = Optional.of(new Launch(2, 0, 0, true));
    port.routes.clear();
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "A ready answer of another epoch is one dead probe");
    check(port.routes.equals(List.of(LocalRuntimeHealth.HEALTH_ROUTE)), "No storage probe from an unready agent");
    port.launch = Optional.of(new Launch(2, 2, 0, true));
    expect(health.read(321), Agent.FAILING, Storage.UNAVAILABLE, "Third dead probe fails");
    port.health = new Reply(200, "not json");
    port.launch = Optional.of(new Launch(2, 1, 0, true));
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "Unparsed body is one dead probe");
    port.health = new Reply(200, "{\"ready\":true,\"runtime\":\"ok\",\"agentState\":\"running\",\"epoch\":\"2\"}");
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "A string epoch is not ready");

    port.silent = true;
    port.alive = true;
    port.launch = Optional.of(new Launch(2, 2, 1, true));
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "Silent live child is busy and adds no strike");
    port.launch = Optional.of(new Launch(2, 0, 2, true));
    expect(health.read(321), Agent.FAILING, Storage.UNAVAILABLE, "Third busy probe fails");
    port.alive = false;
    port.accepts = true;
    port.launch = Optional.of(new Launch(2, 0, 0, true));
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "Accepting socket is busy");
    port.accepts = false;
    expect(health.read(321), Agent.WAITING, Storage.UNAVAILABLE, "One dead probe never fails");

    port.silent = false;
    port.health = ready(2);
    Reading second = health.read(321);
    expect(second, Agent.HEALTHY, Storage.UNAVAILABLE, "Ready agent with unknown storage");
    port.launch = Optional.of(new Launch(3, 0, 0, true));
    check(!health.sameLaunch(second), "A new launch is not the same launch");
    port.launch = Optional.empty();
    check(!health.sameLaunch(second), "A stopped agent is not the same launch");
    try { health.read(0); throw new AssertionError("Zero budget accepted"); } catch (IllegalArgumentException expected) {}
  }
}
