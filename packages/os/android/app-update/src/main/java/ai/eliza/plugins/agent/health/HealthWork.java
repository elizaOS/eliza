// spec/os/appUpdate/health.md, "Only a well-timed updater request for this version starts the worker"; spec/os/appUpdate/health.md, "The agent half is the agent service's verdict for the current launch, and storage counts only from a ready agent"; spec/os/appUpdate/health.md, "Only a failing agent fails an update, and a pass needs a ready agent, its storage and visible content of the same launch"
package ai.eliza.plugins.agent.health;

import java.util.Optional;

public final class HealthWork {
  public enum Admission { UNAUTHORIZED, INVALID_OR_BUSY, ADMITTED }
  public enum Probe { OK, BUSY, DEAD }
  public enum Agent { HEALTHY, WAITING, FAILING }
  public enum Storage { OK, DEFERRED, UNAVAILABLE, NOT_LOADED }
  public enum Screen { ABSENT, BACKGROUND, FAILED, EMPTY, CONTENT }
  public enum Verdict { PASSED, FAILED }

  public static final long MAX_REQUEST_MS = 20000;
  public static final long UI_BUDGET_MS = 1500;
  public static final int RESTART_STRIKES = 3;
  public static final int BUSY_RESTART_TICKS = 3;

  private HealthWork() {}

  public static Admission admission(boolean supervisor, boolean free, long versionCode, long compiledVersion, long deadline, long clock) {
    if (!supervisor) return Admission.UNAUTHORIZED;
    return free && versionCode == compiledVersion && deadline > clock && deadline - clock <= MAX_REQUEST_MS
      ? Admission.ADMITTED : Admission.INVALID_OR_BUSY;
  }

  public static Agent agentHalf(Probe probe, int strikes, int busyTicks) {
    if (probe == Probe.OK) return Agent.HEALTHY;
    boolean restart = probe == Probe.BUSY ? busyTicks + 1 >= BUSY_RESTART_TICKS : strikes + 1 >= RESTART_STRIKES;
    return restart ? Agent.FAILING : Agent.WAITING;
  }

  public static Storage storage(Agent agent, Storage tasks) {
    return agent == Agent.HEALTHY ? tasks : Storage.UNAVAILABLE;
  }

  public static Optional<Verdict> conclude(Agent agent, Storage storage, Screen screen, boolean sameLaunch) {
    if (!sameLaunch) return Optional.empty();
    if (agent == Agent.FAILING) return Optional.of(Verdict.FAILED);
    boolean storageReady = storage == Storage.OK || storage == Storage.NOT_LOADED;
    return agent == Agent.HEALTHY && storageReady && screen == Screen.CONTENT ? Optional.of(Verdict.PASSED) : Optional.empty();
  }

  public static long uiDeadline(long clock, long deadline) {
    return Math.min(deadline, clock + UI_BUDGET_MS);
  }
}
