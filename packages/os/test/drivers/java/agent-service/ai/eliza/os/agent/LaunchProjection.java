// spec/os/agentService/config.md, "Story: Start my agent with my character, policy and model"; spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"
package ai.eliza.os.agent;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

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
    AgentCredentials.Account account = accountOf((Map<String, Object>) ask.get("account"));
    Map<String, Object> worker = (Map<String, Object>) ask.get("workflowWorker");
    Map<String, Object> frame = (Map<String, Object>) ask.get("frame");
    Map<String, Object> resident = (Map<String, Object>) ask.get("residentOwner");
    AgentConfig.WorkflowWorker workflowWorker = worker == null ? null
      : new AgentConfig.WorkflowWorker((String) worker.get("runtimeDir"), (String) worker.get("executable"), (String) worker.get("sha256"));
    String document;
    try {
      if (resident == null) document = config.launchDocument(account, workflowWorker);
      else {
        AgentConfig.ResidentOwner owner = switch ((String) resident.get("kind")) {
          case "installation" -> new AgentConfig.InstallationOwner(accountOf((Map<String, Object>) resident.get("linkedAccount")));
          case "retained-account" -> new AgentConfig.RetainedOwner(accountOf((Map<String, Object>) resident.get("account")));
          default -> throw new IllegalArgumentException("Unknown resident owner fixture");
        };
        AgentConfig.ResidentInference inference = switch ((String) ask.get("residentInference")) {
          case "none" -> new AgentConfig.NoInference();
          case "cloud" -> new AgentConfig.CloudInference(account);
          case "own-key" -> new AgentConfig.OwnKeyInference();
          default -> throw new IllegalArgumentException("Unknown resident inference fixture");
        };
        document = config.residentLaunchDocument(owner, inference, workflowWorker);
      }
    } catch (IllegalArgumentException refused) {
      return Map.of("kind", "refused", "cause", "Config", "reason", refused.getMessage());
    }
    Map<String, Object> held = frame == null ? null : (Map<String, Object>) frame.get("credential");
    LaunchFrame first = frame == null ? null : config.initialFrame(
      (String) frame.get("token"), ((BigDecimal) frame.get("epoch")).longValueExact(),
      held == null ? null : new LaunchFrame.Credential(((BigDecimal) held.get("version")).longValueExact(), (String) held.get("value")),
      (String) frame.get("storageKey"));
    Map<String, Object> answer = new LinkedHashMap<>();
    answer.put("kind", "admitted");
    answer.put("service", config.service);
    answer.put("notification", config.notification.text());
    answer.put("rendererGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.RENDERER).size()));
    answer.put("nativeGroups", BigDecimal.valueOf(config.routes(ChannelPolicy.CallerKind.NATIVE).size()));
    answer.put("needsAccount", config.needsAccount());
    answer.put("document", document);
    if (first != null) {
      LaunchFrame next = first.next(LaunchFrame.newToken(), first.credentialVersion() == 0 ? null : new LaunchFrame.Credential(first.credentialVersion() + 1, "rotated-device-key"), null);
      answer.put("frame", new String(first.encode(), StandardCharsets.UTF_8));
      answer.put("shown", first.toString());
      answer.put("next", new String(next.encode(), StandardCharsets.UTF_8));
      answer.put("pushOfHeldVersion", first.accepts(held == null ? null : new LaunchFrame.Credential(first.credentialVersion(), "same")));
    }
    return answer;
  }

  private static AgentCredentials.Account accountOf(Map<String, Object> account) {
    return account == null ? null : new AgentCredentials.Account((String) account.get("userId"), (String) account.get("organizationId"));
  }

  private static byte[] bytes(Object text) { return text instanceof String value ? value.getBytes(StandardCharsets.UTF_8) : null; }
}
