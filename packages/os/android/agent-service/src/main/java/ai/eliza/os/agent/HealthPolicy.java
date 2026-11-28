// spec/os/agentService/health.md, "A probe is Ok only for a ready answer of the current launch"; spec/os/agentService/health.md, "Three busy probes or three dead probes since the last Ok probe restart the agent"; spec/os/agentService/health.md, "Absence needs two refused connects in a row and the dead journaled child of this launch"; spec/os/agentService/health.md, "The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s"
package ai.eliza.os.agent;

public final class HealthPolicy {
  public static final long PROBE_INTERVAL_MS = 600_000L;
  public static final long CONNECT_CHECK_INTERVAL_MS = 30_000L;
  public static final int RESTART_STRIKES = 3;
  public static final int BUSY_RESTART_TICKS = 3;
  public static final int ABSENCE_REFUSALS = 2;
  public static final long STABLE_RUN_MS = 300_000L;
  private static final long[] RESTART_DELAYS_MS = { 1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L };

  public enum Probe { OK, BUSY, DEAD }
  public enum Verdict { KEEP_RUNNING, RESTART }

  public record HealthBody(boolean ready, String runtime, String agentState, long epoch) {}

  public sealed interface ProbeReply permits Answered, Unanswered {}
  public record Answered(int status, HealthBody body) implements ProbeReply {}
  public record Unanswered(boolean childAlive, boolean socketAccepts) implements ProbeReply {}

  public record JournaledChild(long childEpoch, boolean alive) {}

  public sealed interface Observation permits Probed, ConnectChecked {}
  public record Probed(ProbeReply reply) implements Observation {}
  public record ConnectChecked(boolean refused, JournaledChild child) implements Observation {}

  public record HealthWatch(int strikes, int busyTicks, int refusals) {
    public static final HealthWatch FRESH = new HealthWatch(0, 0, 0);
  }

  private HealthPolicy() {}

  static boolean readyBody(HealthBody body, long epoch) {
    return body != null && body.ready() && "ok".equals(body.runtime()) && "running".equals(body.agentState()) && body.epoch() == epoch;
  }

  public static Probe classify(ProbeReply reply, long epoch) {
    if (reply instanceof Answered answered) return answered.status() >= 200 && answered.status() < 300 && readyBody(answered.body(), epoch) ? Probe.OK : Probe.DEAD;
    Unanswered silent = (Unanswered) reply;
    return silent.childAlive() || silent.socketAccepts() ? Probe.BUSY : Probe.DEAD;
  }

  static boolean absenceProven(int refusals, JournaledChild child, long epoch) {
    return child != null && refusals >= ABSENCE_REFUSALS && child.childEpoch() == epoch && !child.alive();
  }

  static Verdict probeVerdict(HealthWatch watch, Probe result) {
    boolean wedged = result == Probe.BUSY && watch.busyTicks() + 1 >= BUSY_RESTART_TICKS;
    boolean dead = result == Probe.DEAD && watch.strikes() + 1 >= RESTART_STRIKES;
    return wedged || dead ? Verdict.RESTART : Verdict.KEEP_RUNNING;
  }

  static HealthWatch afterProbe(HealthWatch watch, Probe result) {
    return switch (result) {
      case OK -> new HealthWatch(0, 0, watch.refusals());
      case BUSY -> new HealthWatch(watch.strikes(), watch.busyTicks() + 1, watch.refusals());
      case DEAD -> new HealthWatch(watch.strikes() + 1, watch.busyTicks(), watch.refusals());
    };
  }

  public static Verdict verdict(HealthWatch watch, Observation seen, long epoch) {
    if (seen instanceof Probed probed) return probeVerdict(watch, classify(probed.reply(), epoch));
    ConnectChecked checked = (ConnectChecked) seen;
    return checked.refused() && absenceProven(watch.refusals() + 1, checked.child(), epoch) ? Verdict.RESTART : Verdict.KEEP_RUNNING;
  }

  public static HealthWatch afterObservation(HealthWatch watch, Observation seen, long epoch) {
    if (verdict(watch, seen, epoch) == Verdict.RESTART) return HealthWatch.FRESH;
    if (seen instanceof Probed probed) return afterProbe(watch, classify(probed.reply(), epoch));
    ConnectChecked checked = (ConnectChecked) seen;
    return new HealthWatch(watch.strikes(), watch.busyTicks(), checked.refused() ? watch.refusals() + 1 : 0);
  }

  public static long restartDelay(int attempt) {
    return attempt >= 0 && attempt < RESTART_DELAYS_MS.length ? RESTART_DELAYS_MS[attempt] : RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
  }
}
