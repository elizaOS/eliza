// spec/os/appUpdate/health.md, "The agent half is the agent service's verdict for the current launch, and storage counts only from a ready agent"; spec/os/agentService/health.md, "A probe is Ok only for a ready answer of the current launch"
package ai.eliza.plugins.agent.health;

import ai.eliza.plugins.agent.health.HealthWork.Agent;
import ai.eliza.plugins.agent.health.HealthWork.Probe;
import ai.eliza.plugins.agent.health.HealthWork.Storage;
import java.io.IOException;
import java.util.Objects;
import org.json.JSONException;
import org.json.JSONObject;

public final class LocalRuntimeHealth {
  public static final String HEALTH_ROUTE = "/api/health";
  public static final String STORAGE_ROUTE = "/api/tasks/storage";

  public interface AgentPort {
    Launch launch();
    Reply get(long epoch, String route, int timeoutMillis) throws IOException;
    boolean childAlive(long epoch);
    boolean socketAccepts(long epoch);
  }

  public static final class Launch {
    public final long epoch;
    public final int strikes, busyTicks;
    public final boolean tasksLoaded;
    public Launch(long epoch, int strikes, int busyTicks, boolean tasksLoaded) {
      if (epoch < 1 || strikes < 0 || busyTicks < 0) throw new IllegalArgumentException("Invalid agent launch");
      this.epoch = epoch; this.strikes = strikes; this.busyTicks = busyTicks; this.tasksLoaded = tasksLoaded;
    }
  }

  public static final class Reply {
    public final int status;
    public final String body;
    public Reply(int status, String body) {
      this.status = status; this.body = Objects.requireNonNull(body);
    }
  }

  public static final class Reading {
    public final long epoch;
    public final Agent agent;
    public final Storage storage;
    Reading(long epoch, Agent agent, Storage storage) {
      this.epoch = epoch; this.agent = agent; this.storage = storage;
    }
  }

  private final AgentPort agent;
  private final int timeoutMillis;

  public LocalRuntimeHealth(AgentPort agent, int timeoutMillis) {
    if (timeoutMillis <= 0) throw new IllegalArgumentException("Positive probe budget required");
    this.agent = Objects.requireNonNull(agent); this.timeoutMillis = timeoutMillis;
  }

  public Reading read() {
    Launch launch = agent.launch();
    if (launch == null) return new Reading(0, Agent.WAITING, Storage.UNAVAILABLE);
    Agent half = HealthWork.agentHalf(probe(launch), launch.strikes, launch.busyTicks);
    return new Reading(launch.epoch, half, HealthWork.storage(half, half == Agent.HEALTHY ? tasks(launch) : Storage.UNAVAILABLE));
  }

  public boolean sameLaunch(Reading reading) {
    Launch now = agent.launch();
    return (now == null ? 0 : now.epoch) == reading.epoch;
  }

  private Probe probe(Launch launch) {
    try {
      Reply reply = agent.get(launch.epoch, HEALTH_ROUTE, timeoutMillis);
      return reply.status >= 200 && reply.status < 300 && ready(reply.body, launch.epoch) ? Probe.OK : Probe.DEAD;
    } catch (IOException unanswered) {
      return agent.childAlive(launch.epoch) || agent.socketAccepts(launch.epoch) ? Probe.BUSY : Probe.DEAD;
    }
  }

  private static boolean ready(String body, long epoch) {
    try {
      JSONObject value = new JSONObject(body);
      Object answered = value.opt("epoch");
      return Boolean.TRUE.equals(value.opt("ready")) && "ok".equals(value.opt("runtime")) && "running".equals(value.opt("agentState"))
        && (answered instanceof Integer || answered instanceof Long) && ((Number) answered).longValue() == epoch;
    } catch (JSONException unparsed) {
      return false;
    }
  }

  private Storage tasks(Launch launch) {
    if (!launch.tasksLoaded) return Storage.NOT_LOADED;
    try {
      Reply reply = agent.get(launch.epoch, STORAGE_ROUTE, timeoutMillis);
      JSONObject value = new JSONObject(reply.body);
      if (reply.status != 200 || !Integer.valueOf(1).equals(value.opt("schemaVersion"))) return Storage.UNAVAILABLE;
      Object observed = value.opt("taskStorage");
      return "ok".equals(observed) ? Storage.OK : "deferred".equals(observed) ? Storage.DEFERRED : Storage.UNAVAILABLE;
    } catch (IOException | JSONException unread) {
      return Storage.UNAVAILABLE;
    }
  }
}
