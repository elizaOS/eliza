// spec/os/agentService/lifecycle.md, "The agent runs only once it answers ready for this launch, and a launch that never does is restarted after the health delay"; spec/os/agentService/lifecycle.md, "A failed agent's notice is on the alerts channel with the failure words, and a starting, running or stopping agent's on the status channel"; spec/os/agentService/health.md, "The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s"; spec/agent/host/launch.md, "Each boot failure has one exit code, and every code outside the table is a crash"; spec/os/agentService/lifecycle.md, "A replaced mail broker restarts a starting or running agent, and leaves a stopping agent's exit to decide what follows"
package ai.eliza.os.agent;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public final class AgentPolicy {
  public static final long READY_TIMEOUT_MS = 480_000L;

  public enum Phase { STOPPED, CHECKING, SPAWNED, RUNNING, STOPPING, FAILED }
  public enum Cause { PAYLOAD, STORAGE, CONFIG, CREDENTIAL, AGENT, RUNTIME }
  public enum AfterExit { STOP, START, RESTART, FAIL }
  public enum ExitClass { CLEAN, RELEASE_FAILED, CONFIG, CREDENTIAL, STORAGE, AGENT, CRASH }
  public enum Notice { NONE, STATUS, ALERTS }

  public record UpdateTarget(long code, String digest) {
    boolean valid() { return code > 0 && digest != null && digest.matches("[a-f0-9]{64}"); }
  }
  public record RecoveryToken(long epoch, String nonce) {}
  public record Recovery(RecoveryToken token, boolean archiving) {}

  public record State(Phase phase, Cause failure, String error, long epoch, int attempt, boolean reaped, boolean hookRan,
    boolean credentialHeld, long credentialVersion, long delivered, String account, AfterExit afterExit, Cause afterExitCause,
    UpdateTarget hold, Recovery recovery, long staleEpoch) {
    public boolean child() { return staleEpoch != 0 || phase == Phase.SPAWNED || phase == Phase.RUNNING || phase == Phase.STOPPING; }
    public Notice notice() { return phase == Phase.STOPPED ? Notice.NONE : phase == Phase.FAILED ? Notice.ALERTS : Notice.STATUS; }
  }

  public record Status(boolean available, String state, String failure, String error, long epoch, long requestBodyLimit) {}

  public sealed interface Event permits Start, Stop, ReapStale, StaleChildReaped, LaunchHook, Refuse, Spawned, SpawnFailed, ObserveReady, ReadyTimeout,
    ObserveExit, FailUnclassified, RestartUnhealthy, StableReset, CredentialArrived, CredentialReplaced, SignedOut, CredentialExpired,
    AccountChanged, BrokerReplaced, ReviewRecovery, ArchiveRecovery, ArchiveFinished, HoldForUpdate, ReleaseUpdate {}
  public record Start() implements Event {}
  public record Stop() implements Event {}
  public record ReapStale() implements Event {}
  public record StaleChildReaped(long epoch) implements Event {}
  public record LaunchHook(boolean refused, String reason) implements Event {}
  public record Refuse(Cause cause, String reason) implements Event {}
  public record Spawned() implements Event {}
  public record SpawnFailed(String reason) implements Event {}
  public record ObserveReady(long epoch) implements Event {}
  public record ReadyTimeout() implements Event {}
  public record ObserveExit(int code) implements Event {}
  public record FailUnclassified(String reason) implements Event {}
  public record RestartUnhealthy() implements Event {}
  public record StableReset() implements Event {}
  public record CredentialArrived(long version) implements Event {}
  public record CredentialReplaced(long version) implements Event {}
  public record SignedOut() implements Event {}
  public record CredentialExpired() implements Event {}
  public record AccountChanged(String account) implements Event {}
  public record BrokerReplaced() implements Event {}
  public record ReviewRecovery(boolean focused, String nonce) implements Event {}
  public record ArchiveRecovery(RecoveryToken token) implements Event {}
  public record ArchiveFinished(RecoveryToken token, boolean archiveSucceeded) implements Event {}
  public record HoldForUpdate(UpdateTarget target) implements Event {}
  public record ReleaseUpdate(long installedCode, String installedDigest, boolean attemptEnded) implements Event {}

  public sealed interface Effect permits Check, Kill, PushCredential, RecoveryReview, Archive {}
  public record Check(long epoch, String account, long delayMs) implements Effect {}
  public record Kill(long epoch) implements Effect {}
  public record PushCredential(long epoch, long version) implements Effect {}
  public record RecoveryReview(RecoveryToken token) implements Effect {}
  public record Archive(RecoveryToken token, String account) implements Effect {}

  public record Step(boolean accepted, State state, List<Effect> effects) {}

  @FunctionalInterface interface EpochReservation { void reserve(long epoch) throws IOException; }

  private Phase phase = Phase.STOPPED;
  private Cause failure, afterExitCause;
  private String error, account;
  private long epoch, credentialVersion, delivered, staleEpoch;
  private int attempt;
  private boolean reaped, hookRan, credentialHeld;
  private AfterExit afterExit = AfterExit.STOP;
  private UpdateTarget hold;
  private Recovery recovery;
  private final List<Effect> effects = new ArrayList<>();
  private final EpochReservation reservation;

  public AgentPolicy(String account, UpdateTarget hold) {
    this(account, hold, 0, 0, epoch -> {});
  }

  AgentPolicy(String account, UpdateTarget hold, long epoch, long staleEpoch, EpochReservation reservation) {
    this.account = account;
    this.hold = hold;
    this.epoch = epoch;
    this.staleEpoch = staleEpoch;
    this.reservation = reservation;
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

  public synchronized State state() {
    return new State(phase, failure, error, epoch, attempt, reaped, hookRan, credentialHeld, credentialVersion, delivered, account,
      afterExit, afterExitCause, hold, recovery, staleEpoch);
  }

  public synchronized Status status(long requestBodyLimit) {
    String state = switch (phase) {
      case STOPPED, STOPPING -> "stopped";
      case CHECKING, SPAWNED -> "starting";
      case RUNNING -> "running";
      case FAILED -> "failed";
    };
    String named = failure == null ? null : failure.name().toLowerCase(Locale.ROOT);
    return new Status(true, state, named, error, epoch, requestBodyLimit);
  }

  public synchronized Step step(Event event) {
    effects.clear();
    boolean accepted = apply(event);
    List<Effect> out = accepted ? List.copyOf(effects) : List.of();
    effects.clear();
    return new Step(accepted, state(), out);
  }

  private boolean apply(Event event) {
    if (event instanceof Start) return start();
    if (event instanceof Stop) return stop();
    if (event instanceof ReapStale) return reapStale();
    if (event instanceof StaleChildReaped reapedChild) return staleChildReaped(reapedChild.epoch());
    if (event instanceof LaunchHook hook) return launchHook(hook.refused(), hook.reason());
    if (event instanceof Refuse refuse) return refuse(refuse.cause(), refuse.reason());
    if (event instanceof Spawned) return spawned();
    if (event instanceof SpawnFailed failed) return phase == Phase.CHECKING && staleEpoch == 0 && fail(Cause.AGENT, failed.reason());
    if (event instanceof ObserveReady ready) return observeReady(ready.epoch());
    if (event instanceof ReadyTimeout) return phase == Phase.SPAWNED && kill(AfterExit.RESTART, null, null);
    if (event instanceof ObserveExit exit) return observeExit(exit.code());
    if (event instanceof FailUnclassified unclassified) return failUnclassified(unclassified.reason());
    if (event instanceof RestartUnhealthy) return phase == Phase.RUNNING && kill(AfterExit.RESTART, null, null);
    if (event instanceof StableReset) return stableReset();
    if (event instanceof CredentialArrived arrived) return credentialArrived(arrived.version());
    if (event instanceof CredentialReplaced replaced) return credentialReplaced(replaced.version());
    if (event instanceof SignedOut || event instanceof CredentialExpired) return credentialLost();
    if (event instanceof AccountChanged changed) return accountChanged(changed.account());
    if (event instanceof BrokerReplaced) return (phase == Phase.SPAWNED || phase == Phase.RUNNING) && kill(AfterExit.START, null, null);
    if (event instanceof ReviewRecovery review) return reviewRecovery(review.focused(), review.nonce());
    if (event instanceof ArchiveRecovery archive) return archiveRecovery(archive.token());
    if (event instanceof ArchiveFinished finished) return archiveFinished(finished.token(), finished.archiveSucceeded());
    if (event instanceof HoldForUpdate holding) return holdForUpdate(holding.target());
    return releaseUpdate((ReleaseUpdate) event);
  }

  private boolean begin(int nextAttempt, long delayMs) {
    try { reservation.reserve(epoch + 1); }
    catch (IOException failed) { return fail(Cause.RUNTIME, "The agent launch epoch could not be saved: " + failed.getMessage()); }
    phase = Phase.CHECKING;
    epoch++;
    attempt = nextAttempt;
    reaped = false;
    hookRan = false;
    failure = null;
    error = null;
    recovery = null;
    afterExit = AfterExit.STOP;
    afterExitCause = null;
    effects.add(new Check(epoch, account, delayMs));
    return true;
  }

  private boolean fail(Cause cause, String reason) {
    phase = Phase.FAILED;
    failure = cause;
    error = reason;
    afterExit = AfterExit.STOP;
    afterExitCause = null;
    return true;
  }

  private boolean stopped() {
    phase = Phase.STOPPED;
    failure = null;
    error = null;
    afterExit = AfterExit.STOP;
    afterExitCause = null;
    return true;
  }

  private boolean kill(AfterExit then, Cause cause, String reason) {
    phase = Phase.STOPPING;
    afterExit = then;
    afterExitCause = cause;
    error = reason;
    effects.add(new Kill(epoch));
    return true;
  }

  private boolean crash() {
    return begin(attempt == Integer.MAX_VALUE ? attempt : attempt + 1, HealthPolicy.restartDelay(attempt));
  }

  private boolean startable() {
    return hold == null && (phase == Phase.STOPPED || (phase == Phase.FAILED && failure != Cause.STORAGE));
  }

  private boolean start() {
    if (phase == Phase.STOPPING) {
      afterExit = AfterExit.START;
      afterExitCause = null;
      return true;
    }
    return startable() && begin(0, 0);
  }

  private boolean stop() {
    return switch (phase) {
      case CHECKING -> stopped();
      case SPAWNED, RUNNING -> kill(AfterExit.STOP, null, null);
      case STOPPING -> {
        afterExit = AfterExit.STOP;
        afterExitCause = null;
        yield true;
      }
      case FAILED -> failure != Cause.STORAGE && stopped();
      case STOPPED -> false;
    };
  }

  private boolean reapStale() {
    if (phase != Phase.CHECKING || reaped || staleEpoch != 0) return false;
    reaped = true;
    return true;
  }

  private boolean staleChildReaped(long reapedEpoch) {
    if (staleEpoch == 0 || staleEpoch != reapedEpoch) return false;
    staleEpoch = 0;
    return true;
  }

  private boolean launchHook(boolean refused, String reason) {
    if (phase != Phase.CHECKING || !reaped || hookRan) return false;
    if (!credentialHeld) return fail(Cause.CREDENTIAL, "no device credential is held");
    hookRan = true;
    return !refused || fail(Cause.CONFIG, reason);
  }

  private boolean refuse(Cause cause, String reason) {
    if (phase != Phase.CHECKING || staleEpoch != 0 || cause == Cause.AGENT || cause == Cause.RUNTIME) return false;
    if (cause == Cause.STORAGE && !reaped) return false;
    if (cause == Cause.CREDENTIAL && credentialHeld) return false;
    return fail(cause, reason);
  }

  private boolean spawned() {
    if (phase != Phase.CHECKING || !reaped || !hookRan || !credentialHeld || hold != null) return false;
    phase = Phase.SPAWNED;
    delivered = Math.max(delivered, credentialVersion);
    return true;
  }

  private boolean observeReady(long readyEpoch) {
    if (phase != Phase.SPAWNED || readyEpoch != epoch) return false;
    phase = Phase.RUNNING;
    push();
    return true;
  }

  private void push() {
    if (credentialHeld && credentialVersion > delivered) {
      delivered = credentialVersion;
      effects.add(new PushCredential(epoch, delivered));
    }
  }

  private boolean observeExit(int code) {
    String exited = "the agent exited with code " + code;
    return switch (phase) {
      case SPAWNED -> switch (exitClass(code)) {
        case CONFIG -> fail(Cause.CONFIG, exited);
        case STORAGE -> fail(Cause.STORAGE, exited);
        default -> crash();
      };
      case RUNNING -> crash();
      case STOPPING -> switch (afterExit) {
        case STOP -> stopped();
        case START -> begin(0, 0);
        case RESTART -> crash();
        case FAIL -> fail(afterExitCause, error);
      };
      case STOPPED, CHECKING, FAILED -> false;
    };
  }

  private boolean failUnclassified(String reason) {
    return switch (phase) {
      case CHECKING -> fail(Cause.RUNTIME, reason);
      case SPAWNED, RUNNING -> kill(AfterExit.FAIL, Cause.RUNTIME, reason);
      case STOPPED, STOPPING, FAILED -> false;
    };
  }

  private boolean stableReset() {
    if (phase != Phase.RUNNING || attempt == 0) return false;
    attempt = 0;
    return true;
  }

  private boolean credentialArrived(long version) {
    if (version <= 0) return false;
    if (credentialHeld) return credentialReplaced(version);
    credentialHeld = true;
    credentialVersion = Math.max(credentialVersion, version);
    if (phase == Phase.FAILED && failure == Cause.STORAGE) recovery = null;
    if (phase == Phase.FAILED && failure == Cause.CREDENTIAL) return hold == null ? begin(attempt, 0) : stopped();
    if (phase == Phase.STOPPING && afterExit == AfterExit.FAIL && afterExitCause == Cause.CREDENTIAL) {
      afterExit = AfterExit.START;
      afterExitCause = null;
      error = null;
    }
    return true;
  }

  private boolean credentialReplaced(long version) {
    if (!credentialHeld || version <= credentialVersion || version <= delivered) return false;
    credentialVersion = version;
    if (phase == Phase.RUNNING) push();
    return true;
  }

  private boolean credentialLost() {
    if (!credentialHeld) return false;
    credentialHeld = false;
    String reason = "the device credential is no longer held";
    switch (phase) {
      case CHECKING -> fail(Cause.CREDENTIAL, reason);
      case SPAWNED, RUNNING -> kill(AfterExit.FAIL, Cause.CREDENTIAL, reason);
      case STOPPING -> {
        if (afterExit == AfterExit.START || afterExit == AfterExit.RESTART) {
          afterExit = AfterExit.FAIL;
          afterExitCause = Cause.CREDENTIAL;
          error = reason;
        }
      }
      case STOPPED, FAILED -> { }
    }
    return true;
  }

  private boolean accountChanged(String next) {
    if (next == null || next.isEmpty() || next.equals(account)) return false;
    account = next;
    switch (phase) {
      case CHECKING -> {
        if (credentialHeld) begin(0, 0);
      }
      case SPAWNED, RUNNING -> kill(AfterExit.START, null, null);
      case FAILED -> {
        if (failure == Cause.STORAGE) stopped();
      }
      case STOPPED, STOPPING -> { }
    }
    recovery = null;
    return true;
  }

  private boolean reviewRecovery(boolean focused, String nonce) {
    if (phase != Phase.FAILED || failure != Cause.STORAGE || !focused || nonce == null || nonce.isEmpty()) return false;
    if (recovery != null && recovery.archiving()) return false;
    RecoveryToken token = new RecoveryToken(epoch, nonce);
    recovery = new Recovery(token, false);
    effects.add(new RecoveryReview(token));
    return true;
  }

  private boolean archiveRecovery(RecoveryToken token) {
    if (phase != Phase.FAILED || failure != Cause.STORAGE || !recoveryMatches(token, false)) return false;
    recovery = new Recovery(token, true);
    effects.add(new Archive(token, account));
    return true;
  }

  private boolean archiveFinished(RecoveryToken token, boolean archiveSucceeded) {
    if (phase != Phase.FAILED || failure != Cause.STORAGE || !recoveryMatches(token, true)) return false;
    recovery = null;
    if (archiveSucceeded) stopped();
    return true;
  }

  private boolean recoveryMatches(RecoveryToken token, boolean archiving) {
    return recovery != null && recovery.archiving() == archiving && recovery.token().equals(token);
  }

  private boolean holdForUpdate(UpdateTarget target) {
    if (hold != null || target == null || !target.valid() || staleEpoch != 0) return false;
    switch (phase) {
      case CHECKING -> stopped();
      case STOPPED, FAILED -> { }
      case SPAWNED, RUNNING, STOPPING -> {
        return false;
      }
    }
    hold = target;
    return true;
  }

  synchronized boolean canReleaseUpdate(ReleaseUpdate event) {
    if (hold == null) return false;
    boolean successor = event.installedCode() == hold.code() && hold.digest().equals(event.installedDigest());
    return successor || event.attemptEnded();
  }

  private boolean releaseUpdate(ReleaseUpdate event) {
    if (!canReleaseUpdate(event)) return false;
    hold = null;
    return true;
  }
}
