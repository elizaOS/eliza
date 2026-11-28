// spec/os/agentService/lifecycle.md, "A hold is taken only with no child, blocks every start and is released only for its target or an ended attempt"; spec/os/agentService/lifecycle.md, "A failed agent's notice is on the alerts channel with the failure words, and a starting, running or stopping agent's on the status channel"; spec/os/agentService/health.md, "A probe is Ok only for a ready answer of the current launch"; spec/os/agentService/health.md, "The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s"; spec/agent/host/launch.md, "Each boot failure has one exit code, and every code outside the table is a crash"
package ai.eliza.os.agent;

import java.io.BufferedReader;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.OptionalLong;
import java.util.Properties;

public final class LifecycleAdapter {
  private static final BigDecimal SAFE = BigDecimal.valueOf(9_007_199_254_740_991L);
  private static final String ACCOUNT = "account-a";

  private static final class HoldSyncUnavailable extends IOException {
    HoldSyncUnavailable() { super("The update hold directory sync is unavailable"); }
  }

  @FunctionalInterface
  private interface HoldStep {
    AgentPolicy.Step run() throws IOException;
  }

  private record Account(String userId, String organizationId) {
    String key() { return userId + ":" + organizationId; }
  }

  private final UpdateHoldFile updateHold;
  private final ChildJournal journal;
  private final Path directory;
  private final Path stagedHold;
  private final Path restartFile;
  private final boolean specMode;
  private AgentPolicy policy;
  private boolean reopening;
  private boolean holdSyncBlocked;
  private boolean failNextEpochReserve;
  private boolean failNextEpochSync;
  private boolean epochUnconfirmed;
  private long readyEpoch;
  private long tokens;
  private String keyUserId = "";
  private String keyOrgId = "";
  private String launchedUserId = "";
  private String launchedOrgId = "";
  private HealthPolicy.HealthWatch watch = HealthPolicy.HealthWatch.FRESH;

  private LifecycleAdapter(Path directory, boolean reopening, boolean specMode) throws IOException {
    this.directory = directory;
    this.reopening = reopening;
    this.specMode = specMode;
    stagedHold = directory.resolve("hold.next");
    restartFile = directory.resolve("restart.properties");
    updateHold = new UpdateHoldFile(directory, path -> {
      if (holdSyncBlocked) throw new HoldSyncUnavailable();
      syncDirectory(path);
    });
    journal = new ChildJournal(directory.resolve("child"), new ChildJournal.Processes() {
      @Override public OptionalLong startTime(int pid) throws IOException { throw new IOException("The portable fixture does not observe child processes"); }
      @Override public void kill(int pid) throws IOException { throw new IOException("The portable fixture does not stop child processes"); }
    }, path -> {
      if (failNextEpochSync) throw new IOException("The launch epoch directory sync failed");
      syncDirectory(path);
    });
    if (reopening) restoreRestartState();
    else policy = readPolicy(ACCOUNT);
  }

  private void reserveEpoch(long nextEpoch) throws IOException {
    if (failNextEpochReserve) throw new IOException("The launch epoch reservation failed");
    journal.reserveLaunch(nextEpoch);
  }

  private AgentPolicy readPolicy(String account) throws IOException {
    ChildJournal.LaunchState launch = journal.restoreLaunch();
    return new AgentPolicy(account, updateHold.held(), launch.epoch(), launch.staleEpoch(), this::reserveEpoch);
  }

  private void restoreRestartState() throws IOException {
    Properties props = new Properties();
    if (Files.exists(restartFile)) {
      try (var in = Files.newInputStream(restartFile)) { props.load(in); }
    }
    holdSyncBlocked = Boolean.parseBoolean(props.getProperty("holdSyncBlocked", "false"));
    int attempt = Integer.parseInt(props.getProperty("attempt", "0"));
    boolean credHeld = Boolean.parseBoolean(props.getProperty("credentialHeld", "false"));
    long credVersion = Long.parseLong(props.getProperty("credentialVersion", "0"));
    long delivered = Long.parseLong(props.getProperty("delivered", "0"));
    readyEpoch = Long.parseLong(props.getProperty("readyEpoch", "0"));
    tokens = Long.parseLong(props.getProperty("tokens", "0"));
    keyUserId = props.getProperty("keyUserId", "");
    keyOrgId = props.getProperty("keyOrgId", "");
    launchedUserId = props.getProperty("launchedUserId", "");
    launchedOrgId = props.getProperty("launchedOrgId", "");
    String savedAccount = props.getProperty("account", "");
    String account = savedAccount.isEmpty() ? null : savedAccount;
    watch = HealthPolicy.HealthWatch.FRESH;
    epochUnconfirmed = false;
    AgentPolicy.UpdateTarget held;
    if (holdSyncBlocked) {
      long code = Long.parseLong(props.getProperty("unconfirmedHoldCode", "0"));
      String digest = props.getProperty("unconfirmedHoldDigest", "");
      held = code > 0 ? new AgentPolicy.UpdateTarget(code, digest) : null;
    } else {
      held = updateHold.held();
    }
    ChildJournal.LaunchState launch = journal.restoreLaunch();
    policy = new AgentPolicy(account, held, launch.epoch(), launch.staleEpoch(), attempt, credHeld, credVersion, delivered, this::reserveEpoch);
  }

  private static Path disposableDirectory() throws IOException {
    Path directory = Files.createTempDirectory("agent-lifecycle-");
    directory.toFile().deleteOnExit();
    for (String name : List.of("hold", "hold.next", "child", "child.epoch", "restart.properties"))
      directory.resolve(name).toFile().deleteOnExit();
    return directory;
  }

  private static void syncDirectory(Path path) throws IOException {
    try (var channel = FileChannel.open(path, StandardOpenOption.READ)) { channel.force(true); }
  }

  public static void main(String[] args) throws Exception {
    LifecycleAdapter adapter;
    if (args.length == 0) adapter = new LifecycleAdapter(disposableDirectory(), false, false);
    else if (args.length == 2 && List.of("fresh", "reopen").contains(args[1]))
      adapter = new LifecycleAdapter(Path.of(args[0]), "reopen".equals(args[1]), true);
    else throw new IllegalArgumentException("Expected a fixture directory and mode");
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = input.readLine()) != null;) {
      if (line.isBlank()) continue;
      try { output.println(adapter.answer(line)); }
      catch (IOException | RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
    }
  }

  private String answer(String line) throws IOException {
    Map<String, Object> request = object(RouteGate.Json.parse(line));
    if (!request.containsKey("event") && !request.containsKey("raw")) {
      if (reopening) reopening = false;
      else {
        holdSyncBlocked = false;
        failNextEpochReserve = false;
        failNextEpochSync = false;
        epochUnconfirmed = false;
        readyEpoch = 0;
        tokens = 0;
        keyUserId = "";
        keyOrgId = "";
        launchedUserId = "";
        launchedOrgId = "";
        watch = HealthPolicy.HealthWatch.FRESH;
        if (updateHold.held() != null) updateHold.save(null);
        Files.deleteIfExists(directory.resolve("child"));
        Files.deleteIfExists(directory.resolve("child.epoch"));
        Files.deleteIfExists(restartFile);
        policy = readPolicy(specMode ? null : ACCOUNT);
      }
      return "{\"state\":" + state(policy.state()) + ",\"out\":[]}";
    }
    boolean direct = request.containsKey("event");
    Object event = direct ? request.get("event") : request.get("raw");
    AgentPolicy.Step step;
    try {
      Map<String, Object> fields = object(event);
      String type = text(fields.get("type"));
      AgentPolicy.State before = policy.state();
      step = switch (type) {
        case "holdWriteFailed" -> observeFailedAcquire(artifact(fields.get("target")), flag(fields.get("absenceConfirmed")));
        case "observeHoldGrant" -> observeHoldGrant(flag(fields.get("grantSaved")));
        case "processRestarted" -> prepareRecreation(false);
        case "processRestartedWithReservedEpoch" -> prepareRecreation(true);
        case "releaseUpdateFailed" -> observeReleaseFailed(fields, direct);
        case "launchEpochWriteFailed" -> observeLaunchEpochWriteFailed(fields);
        case "observeHealth" -> observeHealth(fields);
        case "restartUnhealthy" -> restartUnhealthy(fields, direct);
        case "stopCheckingForHold" -> stopCheckingForHold();
        case "credentialArrived" -> handleCredentialArrived(fields, direct);
        case "accountChanged" -> handleAccountChanged(fields, direct);
        case "reviewRecovery" -> handleReviewRecovery(fields, direct);
        case "archiveRecovery" -> handleArchiveRecovery(fields, direct);
        case "archiveFinished" -> handleArchiveFinished(fields, direct);
        case "spawn" -> handleSpawn(fields, direct);
        case "reapStale" -> handleReapStale();
        case "observeReady" -> handleObserveReady(fields, direct);
        case "stableRun" -> policy.step(new AgentPolicy.StableReset());
        case "credentialWithdrawn" -> policy.step(new AgentPolicy.SignedOut());
        default -> apply(decode(fields, direct));
      };
      if (step.accepted()) {
        if (step.state().epoch() != before.epoch()) {
          watch = HealthPolicy.HealthWatch.FRESH;
          epochUnconfirmed = false;
        }
        if (step.state().staleEpoch() == 0 && before.staleEpoch() != 0) Files.deleteIfExists(directory.resolve("child"));
      }
    }
    catch (IllegalArgumentException | ArithmeticException malformed) { step = new AgentPolicy.Step(false, policy.state(), List.of()); }
    return "{\"outcome\":\"" + (step.accepted() ? "accepted" : "refused") + "\",\"state\":" + state(step.state()) + ",\"out\":" + effects(step.effects()) + "}";
  }

  private AgentPolicy.Step prepareRecreation(boolean withReservedEpoch) throws IOException {
    AgentPolicy.State live = policy.state();
    if (withReservedEpoch && !epochUnconfirmed) return new AgentPolicy.Step(false, live, List.of());
    long targetEpoch = withReservedEpoch ? live.epoch() + 1 : live.epoch();
    if (targetEpoch > 0) Files.writeString(directory.resolve("child.epoch"), targetEpoch + "\n", StandardCharsets.US_ASCII);
    else Files.deleteIfExists(directory.resolve("child.epoch"));
    boolean ownedChild = live.phase() == AgentPolicy.Phase.SPAWNED || live.phase() == AgentPolicy.Phase.RUNNING || live.phase() == AgentPolicy.Phase.STOPPING;
    long nextStale = ownedChild ? live.epoch() : live.staleEpoch();
    if (nextStale > 0) Files.writeString(directory.resolve("child"), nextStale + " 1 -1\n", StandardCharsets.US_ASCII);
    else Files.deleteIfExists(directory.resolve("child"));
    Properties props = new Properties();
    props.setProperty("holdSyncBlocked", Boolean.toString(holdSyncBlocked));
    props.setProperty("attempt", Integer.toString(live.attempt()));
    props.setProperty("credentialHeld", Boolean.toString(live.credentialHeld()));
    props.setProperty("credentialVersion", Long.toString(live.credentialVersion()));
    props.setProperty("delivered", Long.toString(live.delivered()));
    props.setProperty("readyEpoch", Long.toString(readyEpoch));
    props.setProperty("tokens", Long.toString(tokens));
    props.setProperty("keyUserId", keyUserId);
    props.setProperty("keyOrgId", keyOrgId);
    props.setProperty("launchedUserId", launchedUserId);
    props.setProperty("launchedOrgId", launchedOrgId);
    props.setProperty("account", live.account() == null ? "" : live.account());
    if (holdSyncBlocked && live.hold() != null) {
      props.setProperty("unconfirmedHoldCode", Long.toString(live.hold().code()));
      props.setProperty("unconfirmedHoldDigest", live.hold().digest());
    }
    try (var out = Files.newOutputStream(restartFile)) { props.store(out, null); }
    return new AgentPolicy.Step(true, live, List.of());
  }

  private AgentPolicy.Step observeLaunchEpochWriteFailed(Map<String, Object> fields) {
    Map<String, Object> req = object(fields.get("request"));
    boolean syncUnconfirmed = flag(fields.get("syncUnconfirmed"));
    AgentPolicy.State live = policy.state();
    String tag = text(req.get("tag"));
    boolean allowed;
    AgentPolicy.Event triggerEvent = null;
    Account credAccount = null;
    long credVersion = 0;
    switch (tag) {
      case "StartRequested" -> {
        allowed = live.hold() == null && !(live.phase() == AgentPolicy.Phase.FAILED && live.failure() == AgentPolicy.Cause.STORAGE)
          && (live.phase() == AgentPolicy.Phase.STOPPED || live.phase() == AgentPolicy.Phase.FAILED);
        triggerEvent = new AgentPolicy.Start();
      }
      case "ExitObserved" -> {
        int code = Math.toIntExact(whole(req.get("code")));
        boolean owned = live.phase() == AgentPolicy.Phase.SPAWNED || live.phase() == AgentPolicy.Phase.RUNNING || live.phase() == AgentPolicy.Phase.STOPPING;
        if (!owned) allowed = false;
        else if (live.phase() == AgentPolicy.Phase.RUNNING) allowed = true;
        else if (live.phase() == AgentPolicy.Phase.SPAWNED) {
          AgentPolicy.ExitClass cls = AgentPolicy.exitClass(code);
          allowed = cls != AgentPolicy.ExitClass.CONFIG && cls != AgentPolicy.ExitClass.STORAGE;
        } else {
          allowed = live.afterExit() == AgentPolicy.AfterExit.START || live.afterExit() == AgentPolicy.AfterExit.RESTART;
        }
        triggerEvent = new AgentPolicy.ObserveExit(code);
      }
      case "CredentialObserved" -> {
        credVersion = whole(req.get("version"));
        credAccount = readAccount(req.get("account"));
        allowed = !live.credentialHeld() && credVersion > live.credentialVersion()
          && live.phase() == AgentPolicy.Phase.FAILED && live.failure() == AgentPolicy.Cause.CREDENTIAL && live.hold() == null;
      }
      default -> throw new IllegalArgumentException("not a launch request");
    }
    if (!allowed) return new AgentPolicy.Step(false, live, List.of());
    failNextEpochReserve = !syncUnconfirmed;
    failNextEpochSync = syncUnconfirmed;
    try {
      AgentPolicy.Step step;
      if (credAccount != null) {
        step = policy.credentialArrived(credVersion, credAccount.key());
        if (step.accepted()) {
          keyUserId = credAccount.userId();
          keyOrgId = credAccount.organizationId();
        }
      } else {
        step = policy.step(triggerEvent);
      }
      if (step.accepted()) epochUnconfirmed = epochUnconfirmed || syncUnconfirmed;
      return step;
    } finally {
      failNextEpochReserve = false;
      failNextEpochSync = false;
    }
  }

  private AgentPolicy.Step observeHealth(Map<String, Object> fields) {
    HealthPolicy.Observation observed = readObservation(fields.get("observed"));
    AgentPolicy.State live = policy.state();
    if (live.phase() != AgentPolicy.Phase.RUNNING || HealthPolicy.verdict(watch, observed, live.epoch()) != HealthPolicy.Verdict.KEEP_RUNNING)
      return new AgentPolicy.Step(false, live, List.of());
    watch = HealthPolicy.afterObservation(watch, observed, live.epoch());
    return new AgentPolicy.Step(true, live, List.of());
  }

  private AgentPolicy.Step restartUnhealthy(Map<String, Object> fields, boolean direct) {
    AgentPolicy.State live = policy.state();
    if (specMode || fields.containsKey("observed")) {
      HealthPolicy.Observation observed = readObservation(fields.get("observed"));
      if (live.phase() != AgentPolicy.Phase.RUNNING || HealthPolicy.verdict(watch, observed, live.epoch()) != HealthPolicy.Verdict.RESTART)
        return new AgentPolicy.Step(false, live, List.of());
    } else if (!direct) {
      throw new IllegalArgumentException("missing observed health");
    }
    AgentPolicy.Step step = policy.step(new AgentPolicy.RestartUnhealthy());
    if (step.accepted()) watch = HealthPolicy.HealthWatch.FRESH;
    return step;
  }

  private AgentPolicy.Step stopCheckingForHold() {
    AgentPolicy.State live = policy.state();
    if (live.phase() == AgentPolicy.Phase.CHECKING) return policy.step(new AgentPolicy.Stop());
    return new AgentPolicy.Step(true, live, List.of());
  }

  private AgentPolicy.Step handleCredentialArrived(Map<String, Object> fields, boolean direct) {
    long version = whole(fields.get("version"));
    if (specMode || fields.containsKey("account")) {
      Account account = readAccount(fields.get("account"));
      AgentPolicy.Step step = policy.credentialArrived(version, account.key());
      if (step.accepted()) {
        keyUserId = account.userId();
        keyOrgId = account.organizationId();
      }
      return step;
    }
    if (!direct) throw new IllegalArgumentException("missing account");
    return policy.step(new AgentPolicy.CredentialArrived(version));
  }

  private AgentPolicy.Step handleAccountChanged(Map<String, Object> fields, boolean direct) {
    if (specMode || fields.containsKey("version")) {
      long version = whole(fields.get("version"));
      Account account = readAccount(fields.get("account"));
      AgentPolicy.Step step = policy.accountChanged(version, account.key());
      if (step.accepted()) {
        keyUserId = account.userId();
        keyOrgId = account.organizationId();
      }
      return step;
    }
    if (!direct) throw new IllegalArgumentException("missing version");
    return policy.step(new AgentPolicy.AccountChanged(text(fields.get("account"))));
  }

  private AgentPolicy.Step handleReviewRecovery(Map<String, Object> fields, boolean direct) {
    boolean focused = flag(fields.get("focused"));
    if (!specMode && direct && fields.containsKey("nonce"))
      return policy.step(new AgentPolicy.ReviewRecovery(focused, text(fields.get("nonce"))));
    AgentPolicy.State live = policy.state();
    if (!focused || live.phase() != AgentPolicy.Phase.FAILED || live.failure() != AgentPolicy.Cause.STORAGE
        || live.staleEpoch() != 0 || (live.recovery() != null && live.recovery().archiving()))
      return new AgentPolicy.Step(false, live, List.of());
    long nextToken = tokens + 1;
    AgentPolicy.Step step = policy.step(new AgentPolicy.ReviewRecovery(true, Long.toString(nextToken)));
    if (step.accepted()) tokens = nextToken;
    return step;
  }

  private AgentPolicy.Step handleArchiveRecovery(Map<String, Object> fields, boolean direct) {
    if (!specMode && direct && fields.get("token") instanceof Map<?, ?>)
      return policy.step(new AgentPolicy.ArchiveRecovery(readToken(fields.get("token"))));
    long token = whole(fields.get("token"));
    return policy.step(new AgentPolicy.ArchiveRecovery(new AgentPolicy.RecoveryToken(policy.state().epoch(), Long.toString(token))));
  }

  private AgentPolicy.Step handleArchiveFinished(Map<String, Object> fields, boolean direct) {
    boolean succeeded = flag(fields.get("archiveSucceeded"));
    if (!specMode && direct && fields.get("token") instanceof Map<?, ?>)
      return policy.step(new AgentPolicy.ArchiveFinished(readToken(fields.get("token")), succeeded));
    long token = whole(fields.get("token"));
    return policy.step(new AgentPolicy.ArchiveFinished(new AgentPolicy.RecoveryToken(policy.state().epoch(), Long.toString(token)), succeeded));
  }

  private AgentPolicy.Step handleSpawn(Map<String, Object> fields, boolean direct) {
    boolean ok = (!specMode && direct && !fields.containsKey("ok")) || flag(fields.get("ok"));
    AgentPolicy.State live = policy.state();
    if (specMode) {
      if (live.phase() != AgentPolicy.Phase.CHECKING || live.staleEpoch() != 0 || !live.credentialHeld())
        return new AgentPolicy.Step(false, live, List.of());
      if (!ok) return policy.step(new AgentPolicy.SpawnFailed("the agent could not be spawned"));
      if (!live.reaped()) policy.step(new AgentPolicy.ReapStale());
      if (!policy.state().hookRan()) policy.step(new AgentPolicy.LaunchHook(false, ""));
      AgentPolicy.Step step = policy.step(new AgentPolicy.Spawned());
      if (step.accepted()) {
        launchedUserId = keyUserId;
        launchedOrgId = keyOrgId;
      }
      return step;
    }
    if (ok) return policy.step(new AgentPolicy.Spawned());
    if (!live.reaped() || !live.hookRan()) throw new IllegalArgumentException("the launch prechecks did not complete");
    return policy.step(new AgentPolicy.SpawnFailed("the agent could not be spawned"));
  }

  private AgentPolicy.Step handleReapStale() {
    AgentPolicy.State live = policy.state();
    if (specMode) {
      if (live.staleEpoch() == 0) return new AgentPolicy.Step(false, live, List.of());
      return policy.step(new AgentPolicy.StaleChildReaped(live.staleEpoch()));
    }
    return policy.step(new AgentPolicy.ReapStale());
  }

  private AgentPolicy.Step handleObserveReady(Map<String, Object> fields, boolean direct) {
    AgentPolicy.ObserveReady ready = readyEvent(fields, direct);
    AgentPolicy.Step step = policy.step(ready);
    if (step.accepted()) {
      readyEpoch = step.state().epoch();
      watch = HealthPolicy.HealthWatch.FRESH;
    }
    return step;
  }

  private AgentPolicy.Step observeReleaseFailed(Map<String, Object> fields, boolean direct) throws IOException {
    AgentPolicy.ReleaseUpdate release = releaseEvent(fields, direct && !specMode);
    if (!policy.canReleaseUpdate(release)) return new AgentPolicy.Step(false, policy.state(), List.of());
    if (holdSyncBlocked) return new AgentPolicy.Step(true, policy.state(), List.of());
    return observeStagedWriteFailure(() -> updateHold.release(policy, release));
  }

  private AgentPolicy.Step observeStagedWriteFailure(HoldStep step) throws IOException {
    Files.createDirectory(stagedHold);
    try {
      AgentPolicy.Step result = step.run();
      if (result.accepted()) throw new IOException("The blocked hold write unexpectedly succeeded");
      return result;
    } catch (FileNotFoundException failed) {
      return new AgentPolicy.Step(true, policy.state(), List.of());
    } finally {
      Files.delete(stagedHold);
    }
  }

  private AgentPolicy.Step observeFailedAcquire(AgentPolicy.UpdateTarget target, boolean absenceConfirmed) throws IOException {
    if (absenceConfirmed) {
      AgentPolicy.Step result = observeStagedWriteFailure(() -> updateHold.acquire(policy, journal, target));
      if (result.accepted() && (result.state().hold() != null || updateHold.held() != null))
        throw new IOException("The blocked hold write did not leave a confirmed absence");
      return result;
    }
    boolean wasBlocked = holdSyncBlocked;
    holdSyncBlocked = true;
    boolean retained = false;
    try {
      AgentPolicy.Step result = updateHold.acquire(policy, journal, target);
      if (result.accepted()) throw new IOException("The unsynced hold write unexpectedly succeeded");
      return result;
    } catch (HoldSyncUnavailable failed) {
      AgentPolicy.State live = policy.state();
      if (!target.equals(live.hold())) throw new IOException("The unsynced hold write did not retain its target", failed);
      retained = true;
      return new AgentPolicy.Step(true, live, List.of());
    } finally {
      holdSyncBlocked = wasBlocked || retained;
    }
  }

  private AgentPolicy.Step observeHoldGrant(boolean grantSaved) throws IOException {
    AgentPolicy.State live = policy.state();
    if (!holdSyncBlocked || live.phase() != AgentPolicy.Phase.STOPPED || live.hold() == null)
      return new AgentPolicy.Step(false, live, List.of());
    holdSyncBlocked = false;
    boolean settled = false;
    try {
      if (grantSaved) {
        if (!live.hold().equals(updateHold.held())) throw new IOException("The saved grant differs from the fenced target");
        settled = true;
        return new AgentPolicy.Step(true, live, List.of());
      }
      updateHold.save(null);
      AgentPolicy.Step released = policy.step(new AgentPolicy.ReleaseUpdate(0, null, true));
      settled = released.accepted();
      return released;
    } finally {
      holdSyncBlocked = !settled;
    }
  }

  private AgentPolicy.Step apply(AgentPolicy.Event event) throws IOException {
    if (event instanceof AgentPolicy.HoldForUpdate hold) return updateHold.acquire(policy, journal, hold.target());
    if (event instanceof AgentPolicy.ReleaseUpdate release) return releaseHold(release);
    return policy.step(event);
  }

  private AgentPolicy.Step releaseHold(AgentPolicy.ReleaseUpdate release) throws IOException {
    if (!holdSyncBlocked || !policy.canReleaseUpdate(release)) return updateHold.release(policy, release);
    holdSyncBlocked = false;
    boolean released = false;
    try {
      AgentPolicy.Step result = updateHold.release(policy, release);
      released = result.accepted();
      return result;
    } finally {
      holdSyncBlocked = !released;
    }
  }

  private AgentPolicy.Event decode(Map<String, Object> event, boolean direct) {
    return switch (text(event.get("type"))) {
      case "start" -> new AgentPolicy.Start();
      case "stop" -> new AgentPolicy.Stop();
      case "launchHook" -> new AgentPolicy.LaunchHook(flag(event.get("refused")), "the launch hook refused");
      case "refuse" -> new AgentPolicy.Refuse(named(AgentPolicy.Cause.values(), event.get("cause")), "a start check refused");
      case "spawnFailed" -> new AgentPolicy.SpawnFailed("the agent could not be spawned");
      case "readinessTimedOut" -> new AgentPolicy.ReadyTimeout();
      case "timeout" -> {
        if (!direct || specMode) throw new IllegalArgumentException("not an event of the agent service");
        yield new AgentPolicy.ReadyTimeout();
      }
      case "observeExit" -> new AgentPolicy.ObserveExit(Math.toIntExact(whole(event.get("code"))));
      case "failUnclassified" -> new AgentPolicy.FailUnclassified("an unclassified failure");
      case "stableReset" -> {
        if (!direct || specMode) throw new IllegalArgumentException("not an event of the agent service");
        yield new AgentPolicy.StableReset();
      }
      case "credentialReplaced" -> new AgentPolicy.CredentialReplaced(whole(event.get("version")));
      case "signedOut" -> {
        if (!direct || specMode) throw new IllegalArgumentException("not an event of the agent service");
        yield new AgentPolicy.SignedOut();
      }
      case "credentialExpired" -> {
        if (!direct || specMode) throw new IllegalArgumentException("not an event of the agent service");
        yield new AgentPolicy.CredentialExpired();
      }
      case "brokerReplaced" -> new AgentPolicy.BrokerReplaced();
      case "holdForUpdate" -> new AgentPolicy.HoldForUpdate(direct && !specMode && !event.containsKey("target")
        ? new AgentPolicy.UpdateTarget(whole(event.get("targetCode")), text(event.get("targetDigest"))) : artifact(event.get("target")));
      case "releaseUpdate" -> releaseEvent(event, direct && !specMode);
      default -> throw new IllegalArgumentException("not an event of the agent service");
    };
  }

  private static Account readAccount(Object value) {
    Map<String, Object> acc = object(value);
    String userId = text(acc.get("userId"));
    String orgId = text(acc.get("organizationId"));
    if (userId.isEmpty() || orgId.isEmpty()) throw new IllegalArgumentException("account must be named");
    return new Account(userId, orgId);
  }

  private static HealthPolicy.Observation readObservation(Object value) {
    Map<String, Object> obs = object(value);
    return switch (text(obs.get("tag"))) {
      case "Probed" -> new HealthPolicy.Probed(probeReply(obs.get("reply")));
      case "ConnectChecked" -> new HealthPolicy.ConnectChecked(flag(obs.get("refused")), journaledChild(obs.get("child")));
      default -> throw new IllegalArgumentException("not a health observation");
    };
  }

  private static HealthPolicy.JournaledChild journaledChild(Object value) {
    Map<String, Object> child = object(value);
    return switch (text(child.get("tag"))) {
      case "NoJournal" -> null;
      case "Journaled" -> new HealthPolicy.JournaledChild(whole(child.get("childEpoch")), flag(child.get("alive")));
      default -> throw new IllegalArgumentException("not a journaled child");
    };
  }

  private static HealthPolicy.ProbeReply probeReply(Object value) {
    Map<String, Object> wire = object(value);
    return switch (text(wire.get("tag"))) {
      case "Answered" -> new HealthPolicy.Answered(Math.toIntExact(whole(wire.get("status"))), healthBody(wire.get("body")));
      case "Unanswered" -> new HealthPolicy.Unanswered(flag(wire.get("childAlive")), flag(wire.get("socketAccepts")));
      default -> throw new IllegalArgumentException("not a probe reply");
    };
  }

  private static AgentPolicy.UpdateTarget artifact(Object value) {
    long code = whole(value);
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(("artifact:" + code).getBytes(StandardCharsets.UTF_8));
      return new AgentPolicy.UpdateTarget(code, HexFormat.of().formatHex(digest));
    } catch (NoSuchAlgorithmException missing) { throw new IllegalStateException(missing); }
  }

  private static AgentPolicy.ReleaseUpdate releaseEvent(Map<String, Object> event, boolean directLegacy) {
    if (directLegacy && !event.containsKey("result"))
      return new AgentPolicy.ReleaseUpdate(whole(event.get("installedCode")), text(event.get("installedDigest")), flag(event.get("attemptEnded")));
    Map<String, Object> result = object(event.get("result"));
    return switch (text(result.get("tag"))) {
      case "AttemptEnded" -> new AgentPolicy.ReleaseUpdate(0, null, true);
      case "Installed" -> {
        AgentPolicy.UpdateTarget installed = artifact(result.get("artifact"));
        yield new AgentPolicy.ReleaseUpdate(installed.code(), installed.digest(), false);
      }
      default -> throw new IllegalArgumentException("not an update outcome");
    };
  }

  private AgentPolicy.ObserveReady readyEvent(Map<String, Object> event, boolean direct) {
    if (!specMode && direct && !event.containsKey("reply")) return new AgentPolicy.ObserveReady(whole(event.get("epoch")));
    HealthPolicy.ProbeReply reply = probeReply(event.get("reply"));
    if (HealthPolicy.classify(reply, policy.state().epoch()) == HealthPolicy.Probe.OK && reply instanceof HealthPolicy.Answered answered)
      return new AgentPolicy.ObserveReady(answered.body().epoch());
    throw new IllegalArgumentException("the current launch did not report readiness");
  }

  private static HealthPolicy.HealthBody healthBody(Object value) {
    Map<String, Object> body = object(value);
    return switch (text(body.get("tag"))) {
      case "Unparsed" -> null;
      case "Parsed" -> new HealthPolicy.HealthBody(flag(body.get("ready")), text(body.get("runtime")),
        text(body.get("agentState")), whole(body.get("epoch")));
      default -> throw new IllegalArgumentException("not a health body");
    };
  }

  private String state(AgentPolicy.State s) throws IOException {
    String phase = switch (s.phase()) {
      case STOPPED -> "{\"tag\":\"Stopped\"}";
      case CHECKING -> "{\"tag\":\"Starting\",\"stage\":\"Checking\"}";
      case SPAWNED -> "{\"tag\":\"Starting\",\"stage\":\"Spawned\"}";
      case RUNNING -> "{\"tag\":\"Running\"}";
      case STOPPING -> "{\"tag\":\"Stopping\"}";
      case FAILED -> "{\"tag\":\"Failed\",\"cause\":" + quote(tag(s.failure())) + "}";
    };
    String afterExit = s.afterExit() == AgentPolicy.AfterExit.FAIL
      ? "{\"tag\":\"Fail\",\"cause\":" + quote(tag(s.afterExitCause())) + "}"
      : "{\"tag\":" + quote(tag(s.afterExit())) + "}";
    String recovery = s.recovery() == null ? "{\"tag\":\"NoReview\"}"
      : "{\"tag\":\"" + (s.recovery().archiving() ? "Archiving" : "Reviewing") + "\",\"token\":" + token(s.recovery().token()) + "}";
    String notice = switch (s.notice()) {
      case NONE -> "NoNotice";
      case STATUS -> "StatusChannel";
      case ALERTS -> "AlertsChannel";
    };
    return "{\"phase\":" + phase + ",\"notice\":" + quote(notice) + ",\"epoch\":" + s.epoch() + ",\"attempt\":" + s.attempt() + ",\"child\":" + s.child()
      + ",\"reaped\":" + s.reaped() + ",\"hookRan\":" + s.hookRan() + ",\"credentialHeld\":" + s.credentialHeld()
      + ",\"credentialVersion\":" + s.credentialVersion() + ",\"delivered\":" + s.delivered() + ",\"account\":" + quote(s.account())
      + ",\"afterExit\":" + afterExit + ",\"hold\":" + hold(s.hold()) + ",\"recovery\":" + recovery + ",\"spec\":" + specState(s) + "}";
  }

  private String specState(AgentPolicy.State s) {
    String specPhase = switch (s.phase()) {
      case STOPPED -> "{\"tag\":\"Stopped\"}";
      case CHECKING -> "{\"tag\":\"Starting\",\"step\":\"Checking\"}";
      case SPAWNED -> "{\"tag\":\"Starting\",\"step\":\"Spawned\"}";
      case RUNNING -> "{\"tag\":\"Running\"}";
      case STOPPING -> "{\"tag\":\"Stopping\",\"onExit\":" + quote(specAfterExit(s)) + "}";
      case FAILED -> "{\"tag\":\"Failed\",\"cause\":" + quote(tag(s.failure())) + "}";
    };
    String specChild;
    if (s.phase() == AgentPolicy.Phase.SPAWNED || s.phase() == AgentPolicy.Phase.RUNNING || s.phase() == AgentPolicy.Phase.STOPPING)
      specChild = "{\"tag\":\"Owned\",\"ownedEpoch\":" + s.epoch() + "}";
    else if (s.staleEpoch() != 0)
      specChild = "{\"tag\":\"Stale\",\"staleEpoch\":" + s.staleEpoch() + "}";
    else
      specChild = "{\"tag\":\"NoChild\"}";
    String specKey = s.credentialHeld()
      ? "{\"tag\":\"Key\",\"version\":" + s.credentialVersion() + ",\"account\":{\"userId\":" + quote(keyUserId) + ",\"organizationId\":" + quote(keyOrgId) + "}}"
      : "{\"tag\":\"NoKey\"}";
    String specLaunched = "{\"userId\":" + quote(launchedUserId) + ",\"organizationId\":" + quote(launchedOrgId) + "}";
    String specWatch = "{\"strikes\":" + watch.strikes() + ",\"busyTicks\":" + watch.busyTicks() + ",\"refusals\":" + watch.refusals() + "}";
    String specReview;
    if (s.recovery() == null) specReview = "{\"tag\":\"NoReview\"}";
    else {
      long tok = 0;
      try { tok = Long.parseLong(s.recovery().token().nonce()); } catch (NumberFormatException ignored) {}
      specReview = "{\"tag\":" + quote(s.recovery().archiving() ? "Archiving" : "Reviewed")
        + ",\"token\":" + tok + ",\"reviewEpoch\":" + s.recovery().token().epoch() + "}";
    }
    String specHold;
    if (s.hold() == null) specHold = "{\"tag\":\"NotHeld\"}";
    else if (holdSyncBlocked) specHold = "{\"tag\":\"UnconfirmedHold\",\"pendingTarget\":" + s.hold().code() + "}";
    else specHold = "{\"tag\":\"HeldFor\",\"target\":" + s.hold().code() + "}";
    return "{\"phase\":" + specPhase + ",\"epoch\":" + s.epoch() + ",\"attempt\":" + s.attempt()
      + ",\"child\":" + specChild + ",\"readyEpoch\":" + readyEpoch + ",\"key\":" + specKey
      + ",\"newestVersion\":" + s.credentialVersion() + ",\"delivered\":" + s.delivered()
      + ",\"launched\":" + specLaunched + ",\"watch\":" + specWatch + ",\"review\":" + specReview
      + ",\"tokens\":" + tokens + ",\"hold\":" + specHold + ",\"epochUnconfirmed\":" + epochUnconfirmed + "}";
  }

  private static String specAfterExit(AgentPolicy.State s) {
    return switch (s.afterExit()) {
      case STOP -> "ToStopped";
      case START -> "ToStart";
      case RESTART -> "ToRestart";
      case FAIL -> "ToCredentialFailure";
    };
  }

  private String hold(AgentPolicy.UpdateTarget target) throws IOException {
    try {
      AgentPolicy.UpdateTarget saved = updateHold.held();
      if (!Objects.equals(saved, target)) throw new IOException("The persisted update hold differs from the policy");
      return saved == null ? "{\"tag\":\"NotHeld\"}" : holdTarget("Held", saved);
    } catch (HoldSyncUnavailable failed) {
      if (target == null) throw failed;
      return holdTarget("Unconfirmed", target);
    }
  }

  private static String holdTarget(String tag, AgentPolicy.UpdateTarget target) {
    return "{\"tag\":" + quote(tag) + ",\"targetCode\":" + target.code() + ",\"targetDigest\":" + quote(target.digest()) + "}";
  }

  private static String effects(List<AgentPolicy.Effect> effects) {
    List<String> written = new ArrayList<>();
    for (AgentPolicy.Effect effect : effects) {
      if (effect instanceof AgentPolicy.Check check)
        written.add("{\"tag\":\"Check\",\"epoch\":" + check.epoch() + ",\"account\":" + quote(check.account()) + ",\"delayMs\":" + check.delayMs() + "}");
      else if (effect instanceof AgentPolicy.Kill kill)
        written.add("{\"tag\":\"Kill\",\"epoch\":" + kill.epoch() + "}");
      else if (effect instanceof AgentPolicy.PushCredential push)
        written.add("{\"tag\":\"PushCredential\",\"epoch\":" + push.epoch() + ",\"version\":" + push.version() + "}");
      else if (effect instanceof AgentPolicy.RecoveryReview review)
        written.add("{\"tag\":\"RecoveryReview\",\"token\":" + token(review.token()) + "}");
      else if (effect instanceof AgentPolicy.Archive archive)
        written.add("{\"tag\":\"Archive\",\"token\":" + token(archive.token()) + ",\"account\":" + quote(archive.account()) + "}");
    }
    return "[" + String.join(",", written) + "]";
  }

  private static AgentPolicy.RecoveryToken readToken(Object value) {
    Map<String, Object> token = object(value);
    return new AgentPolicy.RecoveryToken(whole(token.get("epoch")), text(token.get("nonce")));
  }

  private static String token(AgentPolicy.RecoveryToken token) {
    return "{\"epoch\":" + token.epoch() + ",\"nonce\":" + quote(token.nonce()) + "}";
  }

  private static String tag(Enum<?> value) {
    StringBuilder out = new StringBuilder();
    for (String word : value.name().split("_")) out.append(word.charAt(0)).append(word.substring(1).toLowerCase(Locale.ROOT));
    return out.toString();
  }

  private static <E extends Enum<E>> E named(E[] values, Object value) {
    String wanted = text(value);
    for (E candidate : values) if (tag(candidate).equals(wanted)) return candidate;
    throw new IllegalArgumentException("unknown name " + wanted);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> object(Object value) {
    if (value instanceof Map<?, ?> map) return (Map<String, Object>) map;
    throw new IllegalArgumentException("expected an object");
  }

  private static String text(Object value) {
    if (value instanceof String text) return text;
    throw new IllegalArgumentException("expected text");
  }

  private static boolean flag(Object value) {
    if (value instanceof Boolean flag) return flag;
    throw new IllegalArgumentException("expected a boolean");
  }

  private static long whole(Object value) {
    if (!(value instanceof BigDecimal number) || number.stripTrailingZeros().scale() > 0 || number.abs().compareTo(SAFE) > 0)
      throw new IllegalArgumentException("expected a safe whole number");
    return number.longValueExact();
  }

  private static String quote(String text) {
    if (text == null) return "null";
    StringBuilder out = new StringBuilder("\"");
    for (int at = 0; at < text.length(); at++) {
      char c = text.charAt(at);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }
}
