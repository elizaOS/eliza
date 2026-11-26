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

  private final UpdateHoldFile updateHold;
  private final ChildJournal journal;
  private final Path directory;
  private final Path stagedHold;
  private AgentPolicy policy;
  private boolean reopening;
  private boolean holdSyncBlocked;

  private LifecycleAdapter(Path directory, boolean reopening) throws IOException {
    this.directory = directory;
    this.reopening = reopening;
    stagedHold = directory.resolve("hold.next");
    updateHold = new UpdateHoldFile(directory, path -> {
      if (holdSyncBlocked) throw new HoldSyncUnavailable();
      syncDirectory(path);
    });
    journal = new ChildJournal(directory.resolve("child"), new ChildJournal.Processes() {
      @Override public OptionalLong startTime(int pid) throws IOException { throw new IOException("The portable fixture does not observe child processes"); }
      @Override public void kill(int pid) throws IOException { throw new IOException("The portable fixture does not stop child processes"); }
    }, LifecycleAdapter::syncDirectory);
    policy = readPolicy(reopening ? null : ACCOUNT);
  }

  private AgentPolicy readPolicy(String account) throws IOException {
    ChildJournal.LaunchState launch = journal.restoreLaunch();
    return new AgentPolicy(account, updateHold.held(), launch.epoch(), launch.staleEpoch(), journal::reserveLaunch);
  }

  private static Path disposableDirectory() throws IOException {
    Path directory = Files.createTempDirectory("agent-lifecycle-");
    directory.toFile().deleteOnExit();
    for (String name : List.of("hold", "hold.next", "child", "child.epoch"))
      directory.resolve(name).toFile().deleteOnExit();
    return directory;
  }

  private static void syncDirectory(Path path) throws IOException {
    try (var channel = FileChannel.open(path, StandardOpenOption.READ)) { channel.force(true); }
  }

  public static void main(String[] args) throws Exception {
    LifecycleAdapter adapter;
    if (args.length == 0) adapter = new LifecycleAdapter(disposableDirectory(), false);
    else if (args.length == 2 && List.of("fresh", "reopen").contains(args[1]))
      adapter = new LifecycleAdapter(Path.of(args[0]), "reopen".equals(args[1]));
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
        if (updateHold.held() != null) updateHold.save(null);
        Files.deleteIfExists(directory.resolve("child"));
        Files.deleteIfExists(directory.resolve("child.epoch"));
        policy = readPolicy(ACCOUNT);
      }
      return "{\"state\":" + state(policy.state()) + ",\"out\":[]}";
    }
    boolean direct = request.containsKey("event");
    Object event = direct ? request.get("event") : request.get("raw");
    AgentPolicy.Step step;
    try {
      Map<String, Object> fields = object(event);
      step = switch (text(fields.get("type"))) {
        case "holdWriteFailed" -> observeFailedAcquire(artifact(fields.get("target")), flag(fields.get("absenceConfirmed")));
        case "observeHoldGrant" -> observeHoldGrant(flag(fields.get("grantSaved")));
        case "processRestarted" -> prepareRecreation(fields);
        case "releaseUpdateFailed" -> {
          AgentPolicy.ReleaseUpdate release = releaseEvent(fields, false);
          yield observeStagedWriteFailure(() -> updateHold.release(policy, release));
        }
        default -> apply(decode(fields, direct));
      };
    }
    catch (IllegalArgumentException | ArithmeticException malformed) { step = new AgentPolicy.Step(false, policy.state(), List.of()); }
    return "{\"outcome\":\"" + (step.accepted() ? "accepted" : "refused") + "\",\"state\":" + state(step.state()) + ",\"out\":" + effects(step.effects()) + "}";
  }

  private AgentPolicy.Step prepareRecreation(Map<String, Object> event) throws IOException {
    AgentPolicy.State live = policy.state();
    if (event.size() != 1 || holdSyncBlocked || live.child() || live.credentialHeld() || live.credentialVersion() != 0
        || live.attempt() != 0 || live.delivered() != 0)
      return new AgentPolicy.Step(false, live, List.of());
    ChildJournal.LaunchState saved = journal.restoreLaunch();
    if (saved.staleEpoch() != 0) return new AgentPolicy.Step(false, live, List.of());
    if (saved.epoch() != live.epoch() || !Objects.equals(updateHold.held(), live.hold()))
      throw new IOException("The saved lifecycle facts differ from the live policy");
    return new AgentPolicy.Step(true, live, List.of());
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
    if (!grantSaved || !holdSyncBlocked || live.phase() != AgentPolicy.Phase.STOPPED || live.hold() == null)
      return new AgentPolicy.Step(false, live, List.of());
    holdSyncBlocked = false;
    boolean confirmed = false;
    try {
      if (!live.hold().equals(updateHold.held())) throw new IOException("The saved grant differs from the fenced target");
      confirmed = true;
      return new AgentPolicy.Step(true, live, List.of());
    } finally {
      holdSyncBlocked = !confirmed;
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
      case "reapStale" -> new AgentPolicy.ReapStale();
      case "launchHook" -> new AgentPolicy.LaunchHook(flag(event.get("refused")), "the launch hook refused");
      case "refuse" -> new AgentPolicy.Refuse(named(AgentPolicy.Cause.values(), event.get("cause")), "a start check refused");
      case "spawn" -> spawnEvent(event, direct);
      case "spawnFailed" -> new AgentPolicy.SpawnFailed("the agent could not be spawned");
      case "observeReady" -> readyEvent(event, direct);
      case "readinessTimedOut" -> new AgentPolicy.ReadyTimeout();
      case "timeout" -> {
        if (!direct) throw new IllegalArgumentException("not an event of the agent service");
        yield new AgentPolicy.ReadyTimeout();
      }
      case "observeExit" -> new AgentPolicy.ObserveExit(Math.toIntExact(whole(event.get("code"))));
      case "failUnclassified" -> new AgentPolicy.FailUnclassified("an unclassified failure");
      case "restartUnhealthy" -> new AgentPolicy.RestartUnhealthy();
      case "stableReset" -> new AgentPolicy.StableReset();
      case "credentialArrived" -> new AgentPolicy.CredentialArrived(whole(event.get("version")));
      case "credentialReplaced" -> new AgentPolicy.CredentialReplaced(whole(event.get("version")));
      case "signedOut" -> new AgentPolicy.SignedOut();
      case "credentialExpired" -> new AgentPolicy.CredentialExpired();
      case "accountChanged" -> new AgentPolicy.AccountChanged(text(event.get("account")));
      case "brokerReplaced" -> new AgentPolicy.BrokerReplaced();
      case "reviewRecovery" -> new AgentPolicy.ReviewRecovery(flag(event.get("focused")), event.containsKey("nonce") ? text(event.get("nonce")) : "review");
      case "archiveRecovery" -> new AgentPolicy.ArchiveRecovery(readToken(event.get("token")));
      case "archiveFinished" -> new AgentPolicy.ArchiveFinished(readToken(event.get("token")), flag(event.get("archiveSucceeded")));
      case "holdForUpdate" -> new AgentPolicy.HoldForUpdate(direct && !event.containsKey("target")
        ? new AgentPolicy.UpdateTarget(whole(event.get("targetCode")), text(event.get("targetDigest"))) : artifact(event.get("target")));
      case "releaseUpdate" -> releaseEvent(event, direct);
      default -> throw new IllegalArgumentException("not an event of the agent service");
    };
  }

  private static AgentPolicy.UpdateTarget artifact(Object value) {
    long code = whole(value);
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(("artifact:" + code).getBytes(StandardCharsets.UTF_8));
      return new AgentPolicy.UpdateTarget(code, HexFormat.of().formatHex(digest));
    } catch (NoSuchAlgorithmException missing) { throw new IllegalStateException(missing); }
  }

  private static AgentPolicy.ReleaseUpdate releaseEvent(Map<String, Object> event, boolean direct) {
    if (direct && !event.containsKey("result"))
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

  private AgentPolicy.Event spawnEvent(Map<String, Object> event, boolean direct) {
    if ((direct && !event.containsKey("ok")) || flag(event.get("ok"))) return new AgentPolicy.Spawned();
    AgentPolicy.State state = policy.state();
    if (!state.reaped() || !state.hookRan()) throw new IllegalArgumentException("the launch prechecks did not complete");
    return new AgentPolicy.SpawnFailed("the agent could not be spawned");
  }

  private AgentPolicy.ObserveReady readyEvent(Map<String, Object> event, boolean direct) {
    if (direct && !event.containsKey("reply")) return new AgentPolicy.ObserveReady(whole(event.get("epoch")));
    Map<String, Object> wire = object(event.get("reply"));
    HealthPolicy.ProbeReply reply = switch (text(wire.get("tag"))) {
      case "Answered" -> new HealthPolicy.Answered(Math.toIntExact(whole(wire.get("status"))), healthBody(wire.get("body")));
      case "Unanswered" -> new HealthPolicy.Unanswered(flag(wire.get("childAlive")), flag(wire.get("socketAccepts")));
      default -> throw new IllegalArgumentException("not a probe reply");
    };
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
      + ",\"afterExit\":" + afterExit + ",\"hold\":" + hold(s.hold()) + ",\"recovery\":" + recovery + "}";
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
