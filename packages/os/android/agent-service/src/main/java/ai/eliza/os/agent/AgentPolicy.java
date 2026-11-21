// spec/os/agentService/lifecycle.md, "A start begins a new launch only from Stopped or Failed, and a start asked during a stop runs after the exit"; spec/os/agentService/lifecycle.md, "A child is spawned only after the stale child is reaped, a key is held and every check passed"; spec/os/agentService/lifecycle.md, "The agent runs only once it answers ready for this launch, and a launch that never does fails as Agent"; spec/os/agentService/lifecycle.md, "A stop before the spawn spawns nothing, and a stop of a live child waits for its exit"; spec/os/agentService/lifecycle.md, "The service restarted by Android keeps the epoch, the key and the hold, and leaves its old child to be reaped"; spec/os/agentService/lifecycle.md, "The status names a failure exactly when the service failed, and the notification is up in every state but Stopped"; spec/os/agentService/lifecycle.md, "Any exit after readiness is a crash, restarted after the health delay while fewer than five restarts were made"; spec/os/agentService/lifecycle.md, "An unhealthy verdict kills the child and counts as a crash"; spec/os/agentService/lifecycle.md, "Five minutes of running renew the restart budget"; spec/os/agentService/lifecycle.md, "Sign-out or an expired key fails the agent as Credential, and a key that arrives then starts it"; spec/os/agentService/lifecycle.md, "Another account's key restarts the agent on that account's directory"; spec/os/agentService/lifecycle.md, "A newer key of the same account is pushed to a running agent and never changes the phase"; spec/os/agentService/lifecycle.md, "Only the exact review token of this failure moves the data aside, and then the agent may start"; spec/os/agentService/lifecycle.md, "A hold is taken only with no child, blocks every start and is released only for its target or an ended attempt"; spec/agent/host/launch.md, "Each boot failure has one exit code, and every code outside the table is a crash"
package ai.eliza.os.agent;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class AgentPolicy {
  public static final long READY_TIMEOUT_MS = 60_000L;

  public enum Phase { STOPPED, CHECKING, SPAWNED, RUNNING, STOPPING, FAILED }
  public enum Cause { PAYLOAD, STORAGE, CONFIG, CREDENTIAL, AGENT, CRASHED, RUNTIME }
  public enum AfterExit { TO_STOPPED, TO_START, TO_RESTART, TO_CREDENTIAL_FAILURE }
  public enum ExitClass { CLEAN, RELEASE_FAILED, CONFIG, CREDENTIAL, STORAGE, AGENT, CRASH }

  public sealed interface Child permits NoChild, Owned, Stale {}
  public record NoChild() implements Child {}
  public record Owned(long epoch) implements Child {}
  public record Stale(long epoch) implements Child {}

  public record Key(long version, String account) {}
  public record UpdateTarget(long code, String digest) {}
  public record RecoveryToken(long token, String nonce) {}
  public record Review(RecoveryToken token, long epoch) {}

  public record State(Phase phase, Cause failure, AfterExit onExit, String error, long epoch, int attempt, Child child, long readyEpoch,
    Key key, long newestVersion, long delivered, String launched, HealthPolicy.HealthWatch watch, Review review, long tokens, UpdateTarget hold) {
    public boolean live() { return child instanceof Owned; }
    public boolean credentialHeld() { return key != null; }
  }

  public record Status(boolean available, String state, String failure, String error, long epoch, long requestBodyLimit) {}

  public sealed interface Event permits Start, Stop, ReapStale, LaunchHook, Refuse, Spawned, SpawnFailed, ObserveReady, ReadyTimeout,
    ObserveExit, ObserveHealth, RestartUnhealthy, StableReset, CredentialArrived, CredentialReplaced, CredentialWithdrawn, AccountChanged,
    ReviewRecovery, ArchiveRecovery, HoldForUpdate, ReleaseUpdate {}
  public record Start() implements Event {}
  public record Stop() implements Event {}
  public record ReapStale() implements Event {}
  public record LaunchHook(boolean refused, String reason) implements Event {}
  public record Refuse(Cause cause, String reason) implements Event {}
  public record Spawned() implements Event {}
  public record SpawnFailed(String reason) implements Event {}
  public record ObserveReady(long epoch) implements Event {}
  public record ReadyTimeout() implements Event {}
  public record ObserveExit(int code) implements Event {}
  public record ObserveHealth(HealthPolicy.Observation observed) implements Event {}
  public record RestartUnhealthy(HealthPolicy.Observation observed) implements Event {}
  public record StableReset() implements Event {}
  public record CredentialArrived(long version, String account) implements Event {}
  public record CredentialReplaced(long version) implements Event {}
  public record CredentialWithdrawn(String reason) implements Event {}
  public record AccountChanged(long version, String account) implements Event {}
  public record ReviewRecovery(boolean focused, String nonce) implements Event {}
  public record ArchiveRecovery(RecoveryToken token) implements Event {}
  public record HoldForUpdate(UpdateTarget target) implements Event {}
  public record ReleaseUpdate(long installedCode, String installedDigest, boolean attemptEnded) implements Event {}

  public sealed interface Effect permits Check, Kill, PushCredential, RecoveryReview, Archive {}
  public record Check(long epoch, long delayMs) implements Effect {}
  public record Kill(long epoch) implements Effect {}
  public record PushCredential(long epoch, long version) implements Effect {}
  public record RecoveryReview(RecoveryToken token) implements Effect {}
  public record Archive(long epoch) implements Effect {}

  public record Step(boolean accepted, State state, List<Effect> effects) {}

  private static final Child NO_CHILD = new NoChild();

  private Phase phase = Phase.STOPPED;
  private Cause failure;
  private AfterExit onExit;
  private String error, launched;
  private long epoch, readyEpoch, newestVersion, delivered, tokens;
  private int attempt;
  private Child child = NO_CHILD;
  private Key key;
  private HealthPolicy.HealthWatch watch = HealthPolicy.HealthWatch.FRESH;
  private Review review;
  private UpdateTarget hold;
  private final List<Effect> effects = new ArrayList<>();

  public AgentPolicy(UpdateTarget hold) {
    this.hold = hold;
  }

  public static AgentPolicy restore(State saved) {
    AgentPolicy back = new AgentPolicy(saved.hold());
    back.epoch = saved.epoch();
    back.attempt = saved.attempt();
    back.readyEpoch = saved.readyEpoch();
    back.key = saved.key();
    back.newestVersion = saved.newestVersion();
    back.delivered = saved.delivered();
    back.launched = saved.launched();
    back.tokens = saved.tokens();
    back.child = saved.child() instanceof Owned owned ? new Stale(owned.epoch()) : saved.child();
    return back;
  }

  public static ExitClass exitClass(int code) {
    return switch (code) {
      case 0 -> ExitClass.CLEAN;
      case 1 -> ExitClass.RELEASE_FAILED;
      case 78 -> ExitClass.CONFIG;
      case 77 -> ExitClass.CREDENTIAL;
      case 74 -> ExitClass.STORAGE;
      case 70 -> ExitClass.AGENT;
      default -> ExitClass.CRASH;
    };
  }

  static Cause startupCause(int code) {
    return switch (exitClass(code)) {
      case CONFIG -> Cause.CONFIG;
      case STORAGE -> Cause.STORAGE;
      case CLEAN, RELEASE_FAILED, CREDENTIAL, AGENT, CRASH -> Cause.AGENT;
    };
  }

  public synchronized State state() {
    return new State(phase, failure, onExit, error, epoch, attempt, child, readyEpoch, key, newestVersion, delivered, launched, watch, review,
      tokens, hold);
  }

  public synchronized Status status(long requestBodyLimit) {
    String state = switch (phase) {
      case STOPPED, STOPPING -> "stopped";
      case CHECKING, SPAWNED -> "starting";
      case RUNNING -> "running";
      case FAILED -> "failed";
    };
    boolean failed = phase == Phase.FAILED;
    return new Status(true, state, failed ? failure.name().toLowerCase(Locale.ROOT) : null, failed ? error : null, epoch, requestBodyLimit);
  }

  public synchronized Step step(Event event) {
    effects.clear();
    boolean accepted = apply(event);
    List<Effect> out = accepted ? List.copyOf(effects) : List.of();
    effects.clear();
    return new Step(accepted, state(), out);
  }

  private boolean apply(Event event) {
    return switch (event) {
      case Start ignored -> hold == null && (phase == Phase.STOPPED || phase == Phase.FAILED || phase == Phase.STOPPING) && start();
      case Stop ignored -> phase != Phase.STOPPED && stop();
      case ReapStale ignored -> child instanceof Stale && reapStale();
      case LaunchHook hook -> checking() && launchHook(hook.refused(), hook.reason());
      case Refuse refused -> refusable(refused.cause()) && enterFailed(refused.cause(), refused.reason());
      case Spawned ignored -> spawnable() && spawned();
      case SpawnFailed failed -> spawnable() && enterFailed(Cause.AGENT, failed.reason());
      case ObserveReady ready -> phase == Phase.SPAWNED && ready.epoch() == epoch && observeReady();
      case ReadyTimeout ignored -> phase == Phase.SPAWNED && readinessTimedOut();
      case ObserveExit exit -> child instanceof Owned && observeExit(exit.code());
      case ObserveHealth health -> phase == Phase.RUNNING && verdict(health.observed()) == HealthPolicy.Verdict.KEEP_RUNNING && observeHealth(health.observed());
      case RestartUnhealthy unhealthy -> phase == Phase.RUNNING && verdict(unhealthy.observed()) == HealthPolicy.Verdict.RESTART && restartUnhealthy();
      case StableReset ignored -> phase == Phase.RUNNING && attempt > 0 && stableRun();
      case CredentialArrived arrived -> key == null && arrived.version() > newestVersion && named(arrived.account())
        && credentialArrived(arrived.version(), arrived.account());
      case CredentialReplaced replaced -> key != null && replaced.version() > newestVersion && credentialReplaced(replaced.version());
      case CredentialWithdrawn withdrawn -> key != null && credentialWithdrawn(withdrawn.reason());
      case AccountChanged changed -> key != null && named(changed.account()) && !key.account().equals(changed.account())
        && changed.version() > newestVersion && accountChanged(changed.version(), changed.account());
      case ReviewRecovery asked -> asked.focused() && storageFailed() && child instanceof NoChild && asked.nonce() != null && !asked.nonce().isEmpty()
        && reviewRecovery(asked.nonce());
      case ArchiveRecovery archive -> storageFailed() && review != null && review.epoch() == epoch && review.token().equals(archive.token())
        && archiveRecovery();
      case HoldForUpdate holding -> holdable(holding.target()) && holdForUpdate(holding.target());
      case ReleaseUpdate release -> hold != null && (release.attemptEnded()
        || (release.installedCode() == hold.code() && hold.digest().equals(release.installedDigest()))) && releaseUpdate();
    };
  }

  private static boolean named(String account) { return account != null && !account.isEmpty(); }

  private boolean checking() { return phase == Phase.CHECKING && child instanceof NoChild; }

  private boolean spawnable() { return checking() && key != null; }

  private boolean storageFailed() { return phase == Phase.FAILED && failure == Cause.STORAGE; }

  private boolean childPhase() { return phase == Phase.SPAWNED || phase == Phase.RUNNING || phase == Phase.STOPPING; }

  private boolean refusable(Cause cause) {
    if (!checking()) return false;
    return switch (cause) {
      case PAYLOAD, CONFIG, STORAGE, RUNTIME -> true;
      case CREDENTIAL -> key == null;
      case AGENT, CRASHED -> false;
    };
  }

  private boolean holdable(UpdateTarget target) {
    return hold == null && target != null && target.code() >= 1 && target.digest() != null && child instanceof NoChild
      && (phase == Phase.STOPPED || phase == Phase.FAILED);
  }

  private HealthPolicy.Verdict verdict(HealthPolicy.Observation observed) {
    return HealthPolicy.verdict(watch, observed, epoch);
  }

  private void enter(Phase next) {
    phase = next;
    failure = null;
    onExit = null;
    error = null;
    review = null;
  }

  private boolean enterStopped() {
    enter(Phase.STOPPED);
    return true;
  }

  private boolean enterFailed(Cause cause, String reason) {
    enter(Phase.FAILED);
    failure = cause;
    error = reason;
    return true;
  }

  private boolean enterStopping(AfterExit then) {
    enter(Phase.STOPPING);
    onExit = then;
    return true;
  }

  private void kill() {
    long target = switch (child) {
      case Owned owned -> owned.epoch();
      case Stale stale -> stale.epoch();
      case NoChild none -> epoch;
    };
    effects.add(new Kill(target));
  }

  private boolean launch(int nextAttempt, long delayMs) {
    enter(Phase.CHECKING);
    epoch++;
    attempt = nextAttempt;
    watch = HealthPolicy.HealthWatch.FRESH;
    effects.add(new Check(epoch, delayMs));
    return true;
  }

  private boolean restartOrFail() {
    if (attempt < HealthPolicy.RESTART_BUDGET) return launch(attempt + 1, HealthPolicy.restartDelay(attempt));
    return enterFailed(Cause.CRASHED, "restarted " + HealthPolicy.RESTART_BUDGET + " times without a stable run");
  }

  private boolean start() {
    if (phase == Phase.STOPPING) {
      onExit = AfterExit.TO_START;
      return true;
    }
    return launch(0, 0);
  }

  private boolean stop() {
    if (phase == Phase.STOPPING) {
      onExit = AfterExit.TO_STOPPED;
      return true;
    }
    if (childPhase()) {
      kill();
      return enterStopping(AfterExit.TO_STOPPED);
    }
    return enterStopped();
  }

  private boolean reapStale() {
    child = NO_CHILD;
    return true;
  }

  private boolean launchHook(boolean refused, String reason) {
    if (key == null) return enterFailed(Cause.CREDENTIAL, "no device credential is held");
    return !refused || enterFailed(Cause.CONFIG, reason);
  }

  private boolean spawned() {
    phase = Phase.SPAWNED;
    child = new Owned(epoch);
    delivered = key.version();
    launched = key.account();
    return true;
  }

  private boolean observeReady() {
    long version = key == null ? 0 : key.version();
    if (version > delivered) effects.add(new PushCredential(epoch, version));
    phase = Phase.RUNNING;
    readyEpoch = epoch;
    delivered = version;
    watch = HealthPolicy.HealthWatch.FRESH;
    return true;
  }

  private boolean readinessTimedOut() {
    kill();
    enterFailed(Cause.AGENT, "the agent did not answer ready within " + READY_TIMEOUT_MS / 1000 + " s");
    child = new Stale(epoch);
    return true;
  }

  private boolean observeExit(int code) {
    child = NO_CHILD;
    return switch (phase) {
      case CHECKING, SPAWNED -> enterFailed(startupCause(code), "the agent exited with code " + code + " before it was ready");
      case RUNNING -> restartOrFail();
      case STOPPING -> switch (onExit) {
        case TO_STOPPED -> enterStopped();
        case TO_START -> launch(0, 0);
        case TO_RESTART -> restartOrFail();
        case TO_CREDENTIAL_FAILURE -> enterFailed(Cause.CREDENTIAL, "the device credential is no longer held");
      };
      case STOPPED, FAILED -> true;
    };
  }

  private boolean observeHealth(HealthPolicy.Observation observed) {
    watch = HealthPolicy.afterObservation(watch, observed, epoch);
    return true;
  }

  private boolean restartUnhealthy() {
    kill();
    enterStopping(AfterExit.TO_RESTART);
    watch = HealthPolicy.HealthWatch.FRESH;
    return true;
  }

  private boolean stableRun() {
    attempt = 0;
    return true;
  }

  private boolean credentialArrived(long version, String account) {
    key = new Key(version, account);
    newestVersion = version;
    if (phase == Phase.FAILED && failure == Cause.CREDENTIAL) return hold == null ? launch(0, 0) : enterStopped();
    if (phase == Phase.STOPPING && onExit == AfterExit.TO_CREDENTIAL_FAILURE) onExit = AfterExit.TO_START;
    return true;
  }

  private boolean credentialReplaced(long version) {
    key = new Key(version, key.account());
    newestVersion = version;
    if (phase == Phase.RUNNING) {
      effects.add(new PushCredential(epoch, version));
      delivered = version;
    }
    return true;
  }

  private boolean credentialWithdrawn(String reason) {
    key = null;
    if (phase == Phase.SPAWNED || phase == Phase.RUNNING) {
      kill();
      return enterStopping(AfterExit.TO_CREDENTIAL_FAILURE);
    }
    if (phase == Phase.STOPPING) {
      if (onExit != AfterExit.TO_STOPPED) onExit = AfterExit.TO_CREDENTIAL_FAILURE;
      return true;
    }
    return phase == Phase.STOPPED || enterFailed(Cause.CREDENTIAL, reason);
  }

  private boolean accountChanged(long version, String account) {
    key = new Key(version, account);
    newestVersion = version;
    if (phase == Phase.SPAWNED || phase == Phase.RUNNING) {
      kill();
      return enterStopping(AfterExit.TO_START);
    }
    if (phase == Phase.STOPPING && onExit == AfterExit.TO_RESTART) onExit = AfterExit.TO_START;
    return true;
  }

  private boolean reviewRecovery(String nonce) {
    tokens++;
    review = new Review(new RecoveryToken(tokens, nonce), epoch);
    effects.add(new RecoveryReview(review.token()));
    return true;
  }

  private boolean archiveRecovery() {
    effects.add(new Archive(epoch));
    return enterStopped();
  }

  private boolean holdForUpdate(UpdateTarget target) {
    hold = target;
    return true;
  }

  private boolean releaseUpdate() {
    hold = null;
    return true;
  }
}
