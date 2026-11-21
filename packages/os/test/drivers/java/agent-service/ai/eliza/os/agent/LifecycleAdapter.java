// spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/lifecycle.md, "Story: Restart a crashed or unhealthy agent within a budget"; spec/os/agentService/lifecycle.md, "Story: Start the agent when I sign in and stop it when I sign out"; spec/os/agentService/lifecycle.md, "Story: Hand a new device key of the same account to the running agent"; spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"; spec/os/agentService/lifecycle.md, "Story: Hold the agent for an app update"
package ai.eliza.os.agent;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class LifecycleAdapter {
  private static final BigDecimal SAFE = BigDecimal.valueOf(9_007_199_254_740_991L);
  private static final String NONCE = "review";
  private static final String DIGEST = "artifact";

  private AgentPolicy policy = new AgentPolicy(null);

  public static void main(String[] args) throws Exception {
    LifecycleAdapter adapter = new LifecycleAdapter();
    BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = input.readLine()) != null;) {
      if (line.isBlank()) continue;
      try { output.println(adapter.answer(line)); }
      catch (RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
    }
  }

  private String answer(String line) {
    Map<String, Object> request = object(RouteGate.Json.parse(line));
    if (!request.containsKey("event") && !request.containsKey("raw")) {
      policy = new AgentPolicy(null);
      return "{\"state\":" + state(policy.state()) + ",\"out\":[]}";
    }
    Map<String, Object> event;
    try { event = object(request.containsKey("event") ? request.get("event") : request.get("raw")); }
    catch (IllegalArgumentException malformed) { return refused(); }
    if ("processRestarted".equals(event.get("type"))) {
      policy = AgentPolicy.restore(policy.state());
      return "{\"outcome\":\"accepted\",\"state\":" + state(policy.state()) + ",\"out\":[]}";
    }
    AgentPolicy.Event decoded;
    try { decoded = decode(event); }
    catch (IllegalArgumentException | ArithmeticException malformed) { return refused(); }
    AgentPolicy.Step step = policy.step(decoded);
    return "{\"outcome\":\"" + (step.accepted() ? "accepted" : "refused") + "\",\"state\":" + state(step.state()) + ",\"out\":" + effects(step.effects()) + "}";
  }

  private String refused() {
    return "{\"outcome\":\"refused\",\"state\":" + state(policy.state()) + ",\"out\":[]}";
  }

  private static AgentPolicy.Event decode(Map<String, Object> event) {
    return switch (text(event.get("type"))) {
      case "start" -> new AgentPolicy.Start();
      case "reapStale" -> new AgentPolicy.ReapStale();
      case "refuse" -> new AgentPolicy.Refuse(cause(text(event.get("cause"))), "a start check refused");
      case "spawn" -> flag(event.get("ok")) ? new AgentPolicy.Spawned() : new AgentPolicy.SpawnFailed("the agent could not be spawned");
      case "readinessTimedOut" -> new AgentPolicy.ReadyTimeout("the agent did not answer ready within 60 s");
      case "observeReady" -> new AgentPolicy.ObserveReady(readyEpoch(reply(object(event.get("reply")))));
      case "stop" -> new AgentPolicy.Stop();
      case "observeExit" -> new AgentPolicy.ObserveExit(Math.toIntExact(whole(event.get("code"))));
      case "observeHealth" -> new AgentPolicy.ObserveHealth(observation(object(event.get("observed"))));
      case "restartUnhealthy" -> new AgentPolicy.RestartUnhealthy(observation(object(event.get("observed"))));
      case "stableRun" -> new AgentPolicy.StableReset();
      case "credentialWithdrawn" -> new AgentPolicy.CredentialWithdrawn("the device credential was withdrawn");
      case "credentialArrived" -> new AgentPolicy.CredentialArrived(whole(event.get("version")), account(object(event.get("account"))));
      case "accountChanged" -> new AgentPolicy.AccountChanged(whole(event.get("version")), account(object(event.get("account"))));
      case "credentialReplaced" -> new AgentPolicy.CredentialReplaced(whole(event.get("version")));
      case "reviewRecovery" -> new AgentPolicy.ReviewRecovery(flag(event.get("focused")), NONCE);
      case "archiveRecovery" -> new AgentPolicy.ArchiveRecovery(new AgentPolicy.RecoveryToken(whole(event.get("token")), NONCE));
      case "holdForUpdate" -> new AgentPolicy.HoldForUpdate(new AgentPolicy.UpdateTarget(whole(event.get("target")), DIGEST));
      case "releaseUpdate" -> release(object(event.get("result")));
      default -> throw new IllegalArgumentException("not an event of the agent service");
    };
  }

  private static long readyEpoch(HealthPolicy.ProbeReply reply) {
    if (reply instanceof HealthPolicy.Answered answered && answered.body() != null
      && HealthPolicy.classify(reply, answered.body().epoch()) == HealthPolicy.Probe.OK) return answered.body().epoch();
    return -1;
  }

  private static AgentPolicy.ReleaseUpdate release(Map<String, Object> result) {
    return switch (text(result.get("tag"))) {
      case "Installed" -> new AgentPolicy.ReleaseUpdate(whole(result.get("artifact")), DIGEST, false);
      case "AttemptEnded" -> new AgentPolicy.ReleaseUpdate(0, null, true);
      default -> throw new IllegalArgumentException("not an update outcome");
    };
  }

  private static HealthPolicy.Observation observation(Map<String, Object> observed) {
    return switch (text(observed.get("tag"))) {
      case "Probed" -> new HealthPolicy.Probed(reply(object(observed.get("reply"))));
      case "ConnectChecked" -> {
        Map<String, Object> child = object(observed.get("child"));
        HealthPolicy.JournaledChild journaled = switch (text(child.get("tag"))) {
          case "NoJournal" -> null;
          case "Journaled" -> new HealthPolicy.JournaledChild(whole(child.get("childEpoch")), flag(child.get("alive")));
          default -> throw new IllegalArgumentException("not a journaled child");
        };
        yield new HealthPolicy.ConnectChecked(flag(observed.get("refused")), journaled);
      }
      default -> throw new IllegalArgumentException("not a health observation");
    };
  }

  private static HealthPolicy.ProbeReply reply(Map<String, Object> reply) {
    return switch (text(reply.get("tag"))) {
      case "Answered" -> {
        Map<String, Object> body = object(reply.get("body"));
        HealthPolicy.HealthBody parsed = switch (text(body.get("tag"))) {
          case "Unparsed" -> null;
          case "Parsed" -> new HealthPolicy.HealthBody(flag(body.get("ready")), text(body.get("runtime")), text(body.get("agentState")), whole(body.get("epoch")));
          default -> throw new IllegalArgumentException("not a health body");
        };
        yield new HealthPolicy.Answered(Math.toIntExact(whole(reply.get("status"))), parsed);
      }
      case "Unanswered" -> new HealthPolicy.Unanswered(flag(reply.get("childAlive")), flag(reply.get("socketAccepts")));
      default -> throw new IllegalArgumentException("not a probe reply");
    };
  }

  private static String account(Map<String, Object> account) {
    String user = text(account.get("userId"));
    String organization = text(account.get("organizationId"));
    return user.isEmpty() || organization.isEmpty() ? "" : user.length() + ":" + user + organization;
  }

  private static String accountJson(String account) {
    if (account == null || account.isEmpty()) return "{\"userId\":\"\",\"organizationId\":\"\"}";
    int colon = account.indexOf(':');
    int length = Integer.parseInt(account.substring(0, colon));
    String rest = account.substring(colon + 1);
    return "{\"userId\":" + quote(rest.substring(0, length)) + ",\"organizationId\":" + quote(rest.substring(length)) + "}";
  }

  private static AgentPolicy.Cause cause(String name) {
    for (AgentPolicy.Cause candidate : AgentPolicy.Cause.values()) if (pascal(candidate.name()).equals(name)) return candidate;
    throw new IllegalArgumentException("unknown cause " + name);
  }

  private static String state(AgentPolicy.State s) {
    String phase = switch (s.phase()) {
      case STOPPED -> "{\"tag\":\"Stopped\"}";
      case CHECKING -> "{\"tag\":\"Starting\",\"step\":\"Checking\"}";
      case SPAWNED -> "{\"tag\":\"Starting\",\"step\":\"Spawned\"}";
      case RUNNING -> "{\"tag\":\"Running\"}";
      case STOPPING -> "{\"tag\":\"Stopping\",\"onExit\":" + quote(pascal(s.onExit().name())) + "}";
      case FAILED -> "{\"tag\":\"Failed\",\"cause\":" + quote(pascal(s.failure().name())) + "}";
    };
    String child = switch (s.child()) {
      case AgentPolicy.NoChild none -> "{\"tag\":\"NoChild\"}";
      case AgentPolicy.Owned owned -> "{\"tag\":\"Owned\",\"ownedEpoch\":" + owned.epoch() + "}";
      case AgentPolicy.Stale stale -> "{\"tag\":\"Stale\",\"staleEpoch\":" + stale.epoch() + "}";
    };
    String key = s.key() == null ? "{\"tag\":\"NoKey\"}"
      : "{\"tag\":\"Key\",\"version\":" + s.key().version() + ",\"account\":" + accountJson(s.key().account()) + "}";
    HealthPolicy.HealthWatch w = s.watch();
    String watch = "{\"strikes\":" + w.strikes() + ",\"busyTicks\":" + w.busyTicks() + ",\"refusals\":" + w.refusals() + "}";
    String review = s.review() == null ? "{\"tag\":\"NoReview\"}"
      : "{\"tag\":\"Reviewed\",\"token\":" + s.review().token().token() + ",\"reviewEpoch\":" + s.review().epoch() + "}";
    String hold = s.hold() == null ? "{\"tag\":\"NotHeld\"}" : "{\"tag\":\"HeldFor\",\"target\":" + s.hold().code() + "}";
    return "{\"phase\":" + phase + ",\"epoch\":" + s.epoch() + ",\"attempt\":" + s.attempt() + ",\"child\":" + child
      + ",\"readyEpoch\":" + s.readyEpoch() + ",\"key\":" + key + ",\"newestVersion\":" + s.newestVersion() + ",\"delivered\":" + s.delivered()
      + ",\"launched\":" + accountJson(s.launched()) + ",\"watch\":" + watch + ",\"review\":" + review + ",\"tokens\":" + s.tokens()
      + ",\"hold\":" + hold + "}";
  }

  private static String effects(List<AgentPolicy.Effect> effects) {
    List<String> written = new ArrayList<>();
    for (AgentPolicy.Effect effect : effects) {
      switch (effect) {
        case AgentPolicy.Check check -> written.add("{\"tag\":\"BeginCheck\",\"epoch\":" + check.epoch() + ",\"delayMs\":" + check.delayMs() + "}");
        case AgentPolicy.Kill kill -> written.add("{\"tag\":\"KillChild\"}");
        case AgentPolicy.PushCredential push -> written.add("{\"tag\":\"PushCredential\",\"pushEpoch\":" + push.epoch() + ",\"version\":" + push.version() + "}");
        case AgentPolicy.Archive archive -> written.add("{\"tag\":\"ArchiveData\"}");
        case AgentPolicy.RecoveryReview review -> { }
      }
    }
    return "[" + String.join(",", written) + "]";
  }

  private static String pascal(String constant) {
    StringBuilder out = new StringBuilder();
    for (String word : constant.split("_")) out.append(word.charAt(0)).append(word.substring(1).toLowerCase(java.util.Locale.ROOT));
    return out.toString();
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
