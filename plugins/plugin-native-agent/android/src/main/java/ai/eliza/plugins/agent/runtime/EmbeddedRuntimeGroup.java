package ai.eliza.plugins.agent.runtime;

import java.nio.charset.StandardCharsets;
import java.util.*;

/** Agent/gateway startup within one existing supervisor scope.
 * Hosts supply commands, private publication, readiness and credential custody.
 * The private files are published before either child starts; the agent and the gateway then
 * boot together, and the launch returns (the session reports RUNNING) only after the agent and
 * then the gateway answer their readiness probes. The gateway's boot must not need a live agent:
 * it reads the published files, and its proxied routes answer "unavailable" until the agent does.
 * The gateway's startup must also not mutate the agent's state while the agent boots: a host
 * that must change agent state at launch (for example wiping a revoked account's data) does so
 * before calling {@link #launch}. A gateway that exits during the agent's wait fails the launch
 * at once rather than after the agent's readiness budget.
 * Use one group per serialized session, never across separate supervisors.
 * No request is replayed and no independent restart policy is introduced.
 */
public final class EmbeddedRuntimeGroup {
  public static final class Endpoint {
    public final int port;
    public final String token;
    private Endpoint(int port, String token) { this.port = port; this.token = token; }
  }
  public interface Broker extends AutoCloseable {
    int port();
    @Override void close();
  }
  @FunctionalInterface public interface AgentCommand { ProcessBuilder create(Endpoint endpoint) throws Exception; }
  @FunctionalInterface public interface GatewayCommand { ProcessBuilder create(Endpoint agent, Endpoint gateway, int brokerPort, String brokerToken) throws Exception; }
  @FunctionalInterface public interface BrokerFactory { Broker open(String token) throws Exception; }
  @FunctionalInterface public interface Publisher { void write(String name, byte[] bytes) throws Exception; }
  @FunctionalInterface public interface Readiness { boolean ready(Endpoint endpoint, boolean gateway) throws Exception; }
  private final NativeProcessLog log;
  private final String token;
  private final Publisher publisher;
  private final Readiness readiness;
  private final long agentBudget, gatewayBudget, poll;
  private volatile Endpoint agent, gateway;

  public EmbeddedRuntimeGroup(NativeProcessLog log, String token, Publisher publisher,
      Readiness readiness, long agentBudget, long gatewayBudget, long poll) {
    if (log == null || token == null || token.isEmpty() || token.matches("(?s).*[\\r\\n\\x00].*")
        || publisher == null || readiness == null || agentBudget < 1 || gatewayBudget < 1
        || agentBudget > 86400000 || gatewayBudget > 86400000 || poll < 1 || poll > Math.min(agentBudget,gatewayBudget))
      throw new IllegalArgumentException("Invalid embedded runtime group policy");
    this.log=log; this.token=token; this.publisher=publisher; this.readiness=readiness;
    this.agentBudget=agentBudget; this.gatewayBudget=gatewayBudget; this.poll=poll;
  }
  /** Endpoint visibility does not grant readiness; callers must use session fences. */
  public Endpoint agent() { return agent; }
  public Endpoint gateway() { return gateway; }

  public void launch(NativeRuntimeSession.Scope scope, AgentCommand agentCommand,
      GatewayCommand gatewayCommand, BrokerFactory brokerFactory, byte[] binding,
      Collection<String> secrets) throws Exception {
    Objects.requireNonNull(binding); Objects.requireNonNull(secrets);
    scope.check();
    Endpoint selectedAgent = new Endpoint(EmbeddedRuntimeLaunch.loopbackPort(),token);
    Endpoint selectedGateway = new Endpoint(EmbeddedRuntimeLaunch.loopbackPort(),EmbeddedRuntimeLaunch.token());
    String brokerToken = EmbeddedRuntimeLaunch.token();
    agent = selectedAgent; gateway = null;
    // Every launch secret is redacted from both children's output.
    List<String> redactions = new ArrayList<>(secrets);
    redactions.add(token); redactions.add(selectedGateway.token); redactions.add(brokerToken);
    // Published to the host's private store before any child exists. The agent receives the same
    // token in its own launch command, so the file reveals nothing the agent does not already hold.
    scope.check(); publisher.write("agent-token",token.getBytes(StandardCharsets.UTF_8));
    scope.check(); publisher.write("gateway-token",selectedGateway.token.getBytes(StandardCharsets.UTF_8));
    scope.check(); publisher.write("credential-binding.json",binding.clone());
    scope.check();
    Process agentProcess = scope.start("agent",agentCommand.create(selectedAgent),log,redactions);
    scope.check();
    Broker broker = Objects.requireNonNull(brokerFactory.open(brokerToken));
    scope.onClose(broker::close);
    scope.check();
    gateway = selectedGateway;
    ProcessBuilder command = gatewayCommand.create(selectedAgent,selectedGateway,broker.port(),brokerToken);
    Process gatewayProcess = scope.start("gateway",command,log,redactions);
    scope.awaitReady(agentProcess,() -> readiness.ready(selectedAgent,false),agentBudget,poll);
    scope.awaitReady(gatewayProcess,() -> readiness.ready(selectedGateway,true),gatewayBudget,poll);
  }
}
