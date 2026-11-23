// spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"; spec/os/agentService/config.md, "Only a cloud launch is handed the mail and calendar broker, by its address and bearer, never a credential"; spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"
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
    Map<String, Object> ask = (Map<String, Object>) RouteGate.Json.parse(line);
    Map<String, Object> answer = new LinkedHashMap<>();
    AgentConfig config;
    try {
      config = AgentConfig.parse(bytes(ask.get("host")), bytes(ask.get("character")), bytes(ask.get("policy")));
    } catch (AgentConfig.Refused refused) {
      answer.put("kind", "refused");
      answer.put("reason", refused.getMessage());
      return answer;
    }
    Map<String, Object> account = (Map<String, Object>) ask.get("account");
    Map<String, Object> worker = (Map<String, Object>) ask.get("workflowWorker");
    Map<String, Object> frame = (Map<String, Object>) ask.get("frame");
    answer.put("kind", "admitted");
    answer.put("service", config.service);
    answer.put("notification", config.notification.text());
    answer.put("rendererGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.RENDERER).size()));
    answer.put("nativeGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.NATIVE).size()));
    answer.put("needsAccount", config.needsAccount());
    answer.put("document", config.launchDocument(
      account == null ? null : new AgentCredentials.Account((String) account.get("userId"), (String) account.get("organizationId")),
      worker == null ? null : new AgentConfig.WorkflowWorker((String) worker.get("runtimeDir"), (String) worker.get("executable"), (String) worker.get("sha256"))));
    if (ask.get("broker") instanceof String broker) answer.put("broker", handoff(config.needsAccount(), broker));
    if (frame != null) {
      Map<String, Object> held = (Map<String, Object>) frame.get("credential");
      LaunchFrame first = LaunchFrame.first((String) frame.get("token"), ((BigDecimal) frame.get("epoch")).longValueExact(),
        held == null ? null : new LaunchFrame.Credential(((BigDecimal) held.get("version")).longValueExact(), (String) held.get("value")),
        (String) frame.get("storageKey"));
      LaunchFrame next = first.next(LaunchFrame.newToken(), first.credentialVersion() == 0 ? null : new LaunchFrame.Credential(first.credentialVersion() + 1, "rotated-device-key"), null);
      answer.put("frame", new String(first.encode(), StandardCharsets.UTF_8));
      answer.put("shown", first.toString());
      answer.put("next", new String(next.encode(), StandardCharsets.UTF_8));
      answer.put("pushOfHeldVersion", first.accepts(held == null ? null : new LaunchFrame.Credential(first.credentialVersion(), "same")));
    }
    return answer;
  }

  private static final String BEARER = "b".repeat(64);

  /** The launch environment for a broker that is "open", "failing" or "absent": each variable handed to the launch, with the bearer shown only as "bearer". */
  private static Object handoff(boolean needsAccount, String state) {
    GoogleBroker broker = switch (state) {
      case "open" -> () -> new GoogleBroker.Endpoint(40123, BEARER);
      case "failing" -> () -> { throw new IOException("the loopback port could not be bound"); };
      default -> null;
    };
    List<String> unavailable = new ArrayList<>();
    Map<String, String> environment = GoogleBroker.launchEnvironment(needsAccount, broker, failed -> unavailable.add(failed.getMessage()));
    if (!unavailable.isEmpty() && !environment.isEmpty()) throw new IllegalStateException("a broker that failed was handed to the launch");
    List<Object> named = new ArrayList<>();
    for (Map.Entry<String, String> variable : new TreeMap<>(environment).entrySet())
      named.add(List.of(variable.getKey(), variable.getValue().equals(BEARER) ? "bearer" : variable.getValue()));
    return named;
  }

  private static byte[] bytes(Object text) { return text instanceof String value ? value.getBytes(StandardCharsets.UTF_8) : null; }
}
