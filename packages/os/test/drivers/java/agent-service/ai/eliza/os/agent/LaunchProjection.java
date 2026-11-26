// spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"; spec/os/agentService/config.md, "The host file names a qualified service class, and status and failure notification words of 1 to 200 characters on two differently named channels"; spec/os/agentService/config.md, "A launch carries the Google consent the owner saved, else the host file's"; spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"; spec/os/agentService/config.md, "Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential"
package ai.eliza.os.agent;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

public final class LaunchProjection {
  public static void main(String[] args) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    for (String line; (line = in.readLine()) != null;) out.println(AgentConfig.json(answer(line)));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> answer(String line) {
    try {
      return project((Map<String, Object>) RouteGate.Json.parse(line));
    } catch (AgentConfig.Refused refused) {
      return Map.of("kind", "refused", "cause", "Config", "reason", refused.getMessage());
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> project(Map<String, Object> ask) throws AgentConfig.Refused {
    AgentConfig config = AgentConfig.parse(bytes(ask.get("host")), bytes(ask.get("character")), bytes(ask.get("policy")));
    Map<String, Object> account = (Map<String, Object>) ask.get("account");
    Map<String, Object> worker = (Map<String, Object>) ask.get("workflowWorker");
    Map<String, Object> frame = (Map<String, Object>) ask.get("frame");
    Map<String, Object> google = (Map<String, Object>) ask.get("google");
    AgentCredentials.Account owner = account == null ? null : new AgentCredentials.Account((String) account.get("userId"), (String) account.get("organizationId"));
    String document = config.launchDocument(owner,
      worker == null ? null : new AgentConfig.WorkflowWorker((String) worker.get("runtimeDir"), (String) worker.get("executable"), (String) worker.get("sha256")),
      google == null ? null : new AgentConfig.GoogleConsent((Boolean) google.get("gmailChanges"), (Boolean) google.get("calendarEdits")));
    Map<String, Object> held = frame == null ? null : (Map<String, Object>) frame.get("credential");
    LaunchFrame first = frame == null ? null : config.initialFrame(
      (String) frame.get("token"), ((BigDecimal) frame.get("epoch")).longValueExact(),
      held == null ? null : new LaunchFrame.Credential(((BigDecimal) held.get("version")).longValueExact(), (String) held.get("value")),
      (String) frame.get("storageKey"));
    Map<String, Object> answer = new LinkedHashMap<>();
    answer.put("kind", "admitted");
    answer.put("service", config.service);
    Map<String, Object> notification = words(config.notification.status());
    notification.put("failure", words(config.notification.failure()));
    answer.put("notification", notification);
    answer.put("rendererGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.RENDERER).size()));
    answer.put("nativeGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.NATIVE).size()));
    answer.put("needsAccount", config.needsAccount());
    answer.put("document", document);
    if (ask.get("broker") instanceof String broker) answer.put("broker", handoff(config.needsAccount(), owner, broker));
    if (first != null) {
      LaunchFrame next = first.next(LaunchFrame.newToken(), first.credentialVersion() == 0 ? null : new LaunchFrame.Credential(first.credentialVersion() + 1, "rotated-device-key"), null);
      answer.put("frame", new String(first.encode(), StandardCharsets.UTF_8));
      answer.put("shown", first.toString());
      answer.put("next", new String(next.encode(), StandardCharsets.UTF_8));
      answer.put("pushOfHeldVersion", first.accepts(held == null ? null : new LaunchFrame.Credential(first.credentialVersion(), "same")));
    }
    return answer;
  }

  private static final String HANDED_BEARER = "b".repeat(64);

  private static final class ProjectedBroker implements GoogleBroker {
    private final boolean opens;
    private boolean revoked;

    ProjectedBroker(boolean opens) { this.opens = opens; }

    @Override public Endpoint open(AgentCredentials.Account owner) throws IOException {
      if (!opens) throw new IOException("the loopback port could not be bound");
      return new Endpoint(40123, HANDED_BEARER);
    }

    @Override public void revoke(Endpoint launched) { revoked = true; }

    @Override public void revoke() { revoked = true; }

    @Override public void close() { revoked = true; }
  }

  private static List<Object> handoff(boolean needsAccount, AgentCredentials.Account owner, String state) {
    ProjectedBroker broker = switch (state) {
      case "open" -> new ProjectedBroker(true);
      case "failing" -> new ProjectedBroker(false);
      default -> null;
    };
    List<String> unavailable = new ArrayList<>();
    GoogleBroker.Endpoint opened = GoogleBroker.forLaunch(needsAccount, owner, broker, failed -> unavailable.add(failed.getMessage()));
    Map<String, String> environment = opened == null ? Map.of() : opened.environment();
    if (!unavailable.isEmpty() && !environment.isEmpty()) throw new IllegalStateException("a broker that failed was handed to the launch");
    if (broker != null && environment.isEmpty() != broker.revoked) throw new IllegalStateException("a launch handed no broker left an earlier bearer admitted");
    List<Object> named = new ArrayList<>();
    for (Map.Entry<String, String> variable : new TreeMap<>(environment).entrySet())
      named.add(List.of(variable.getKey(), variable.getValue().equals(HANDED_BEARER) ? "bearer" : variable.getValue()));
    return named;
  }

  private static Map<String, Object> words(AgentConfig.Words words) {
    Map<String, Object> shown = new LinkedHashMap<>();
    shown.put("channel", words.channel());
    shown.put("title", words.title());
    shown.put("text", words.text());
    return shown;
  }

  private static byte[] bytes(Object text) { return text instanceof String value ? value.getBytes(StandardCharsets.UTF_8) : null; }
}
