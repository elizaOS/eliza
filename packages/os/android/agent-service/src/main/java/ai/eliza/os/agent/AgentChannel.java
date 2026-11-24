// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"; spec/agent/models/binding.md, "A pushed credential replaces the key only at a higher version of the launch account, and needs no restart"
package ai.eliza.os.agent;

import ai.eliza.os.agent.AgentSocketClient.Chunk;
import ai.eliza.os.agent.AgentSocketClient.Complete;
import ai.eliza.os.agent.AgentSocketClient.CredentialPush;
import ai.eliza.os.agent.AgentSocketClient.Event;
import ai.eliza.os.agent.AgentSocketClient.Frame;
import ai.eliza.os.agent.AgentSocketClient.Head;
import ai.eliza.os.agent.AgentSocketClient.HttpCall;
import ai.eliza.os.agent.AgentSocketClient.Link;
import ai.eliza.os.agent.AgentSocketClient.Outgoing;
import ai.eliza.os.agent.AgentSocketClient.PushResult;
import ai.eliza.os.agent.AgentSocketClient.Refusal;
import ai.eliza.os.agent.AgentSocketClient.Result;
import ai.eliza.os.agent.AgentSocketClient.Subscribed;
import ai.eliza.os.agent.AgentSocketClient.Subscription;
import ai.eliza.os.agent.ChannelPolicy.Accepted;
import ai.eliza.os.agent.ChannelPolicy.CallerKind;
import ai.eliza.os.agent.ChannelPolicy.Delivered;
import ai.eliza.os.agent.ChannelPolicy.FailCode;
import ai.eliza.os.agent.ChannelPolicy.FrameKind;
import ai.eliza.os.agent.ChannelPolicy.Out;
import ai.eliza.os.agent.ChannelPolicy.Outcome;
import ai.eliza.os.agent.ChannelPolicy.OutcomeKind;
import ai.eliza.os.agent.ChannelPolicy.Refused;
import ai.eliza.os.agent.ChannelPolicy.Settled;
import ai.eliza.os.agent.ChannelPolicy.Step;
import ai.eliza.os.agent.ChannelPolicy.Topic;
import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

public final class AgentChannel {
  public static final String NATIVE_OWNER = "native";

  public interface Listener {
    void head(String id, long index, int status, Map<String, String> headers);
    void chunk(String id, long index, byte[] data);
    void event(String id, long index, JSONObject event);
    void settled(String id, Outcome outcome, byte[] body);
    default void eventData(String id, String data) { }
  }

  public record Response(int status, byte[] body) {}

  public static final class Unanswered extends Exception {
    private final transient Outcome outcome;

    public Unanswered(Outcome outcome) {
      super(outcome.kind() == OutcomeKind.FAILED ? outcome.code().name() : outcome.kind().name());
      this.outcome = outcome;
    }

    public Outcome outcome() { return outcome; }
  }

  public static final class NotServing extends IOException {
    public NotServing() { super("agent is not serving"); }
  }

  public record Call(AgentChannel channel, String owner, String id) implements AutoCloseable {
    @Override public void close() { channel.abort(owner, id); }
  }

  private final class Live {
    final long seq;
    final String id;
    final Listener listener;
    volatile Link link;
    volatile boolean ended;
    Result result;

    Live(long seq, String id, Listener listener) {
      this.seq = seq;
      this.id = id;
      this.listener = listener;
    }

    void attach(Link attached) {
      link = attached;
      if (ended) attached.close();
    }

    void end() {
      ended = true;
      Link attached = link;
      if (attached != null) attached.close();
    }
  }

  private final ChannelPolicy policy;
  private final AgentSocketClient client;
  private final ExecutorService calls = Executors.newCachedThreadPool(task -> {
    Thread thread = new Thread(task, "AgentChannelCall");
    thread.setDaemon(true);
    return thread;
  });
  private final Map<Long, Live> live = new ConcurrentHashMap<>();
  private volatile Path socket;

  public AgentChannel(ChannelPolicy policy, AgentSocketClient client) {
    this.policy = Objects.requireNonNull(policy);
    this.client = Objects.requireNonNull(client);
  }

  public ChannelPolicy policy() { return policy; }

  public boolean open(long epoch, String rootToken, Path agentSocket) {
    synchronized (policy) {
      if (!policy.open(epoch, rootToken).allowed()) return false;
      socket = agentSocket;
      return true;
    }
  }

  public boolean retire(long epoch) {
    Step step;
    synchronized (policy) {
      step = policy.retire(epoch);
      if (!step.allowed()) return false;
      socket = null;
    }
    for (Out out : step.out()) if (out instanceof Settled settled) settleLive(settled);
    return true;
  }

  public FailCode ask(String owner, String id, String method, String path, boolean streamed, byte[] body, Map<String, ?> headers, Listener listener) {
    return ask(CallerKind.RENDERER, owner, id, method, path, streamed, body, headers, listener);
  }

  public FailCode ask(CallerKind kind, String owner, String id, String method, String path, boolean streamed, byte[] body, Map<String, ?> headers, Listener listener) {
    List<ChannelPolicy.Header> described = ChannelPolicy.headers(headers);
    synchronized (policy) {
      Step step = policy.ask(kind, owner, id, method, path, streamed, body, described);
      return begin(step, listener, new HttpCall(method, path, body, streamed, ChannelPolicy.carried(headers)));
    }
  }

  public FailCode subscribe(String owner, String id, Topic topic, Listener listener) {
    return subscribe(owner, id, topic, owner, listener);
  }

  public FailCode subscribe(String owner, String id, Topic topic, String clientId, Listener listener) {
    Subscription feed = switch (topic) {
      case VOICE -> new Subscription(List.of("voice-transcript"), null);
      case VIEW -> new Subscription(List.of("view-interact"), clientId);
      case NOTICES -> new Subscription(List.of("notification"), null);
    };
    synchronized (policy) { return begin(policy.subscribe(owner, id, topic), listener, feed); }
  }

  public boolean abort(String owner, String id) {
    Live call = null;
    for (Live candidate : live.values()) if (candidate.id.equals(id)) call = candidate;
    if (call == null) return false;
    synchronized (call) {
      Step step = policy.abort(owner, id);
      if (!step.allowed()) return false;
      dispatch(call, step, null);
    }
    return true;
  }

  public void abandon(String owner) {
    for (ChannelPolicy.Entry entry : policy.pending()) if (entry.owner().equals(owner)) abort(owner, entry.id());
  }

  public CompletableFuture<Response> request(CallerKind kind, String method, String path, byte[] body) {
    return request(kind, method, path, body, Map.of());
  }

  public CompletableFuture<Response> request(CallerKind kind, String method, String path, byte[] body, Map<String, ?> headers) {
    CompletableFuture<Response> answer = new CompletableFuture<>();
    FailCode refused = ask(kind, NATIVE_OWNER, UUID.randomUUID().toString(), method, path, false, body, named(headers), new Listener() {
      @Override public void head(String id, long index, int status, Map<String, String> head) { }
      @Override public void chunk(String id, long index, byte[] data) { }
      @Override public void event(String id, long index, JSONObject event) { }
      @Override public void settled(String id, Outcome outcome, byte[] content) {
        if (outcome.kind() == OutcomeKind.RESPONSE) answer.complete(new Response((int) outcome.status(), content));
        else answer.completeExceptionally(new Unanswered(outcome));
      }
    });
    if (refused != null) answer.completeExceptionally(new Unanswered(Outcome.failed(refused)));
    return answer;
  }

  public Call requestStream(CallerKind kind, String method, String path, byte[] body, Listener listener) {
    return requestStream(kind, method, path, body, Map.of(), listener);
  }

  public Call requestStream(CallerKind kind, String method, String path, byte[] body, Map<String, ?> headers, Listener listener) {
    String id = UUID.randomUUID().toString();
    FailCode refused = ask(kind, NATIVE_OWNER, id, method, path, true, body, named(headers), listener);
    if (refused != null) listener.settled(id, Outcome.failed(refused), null);
    return new Call(this, NATIVE_OWNER, id);
  }

  public Call subscribe(Topic topic, Listener listener) {
    String id = UUID.randomUUID().toString();
    FailCode refused = subscribe(NATIVE_OWNER, id, topic, null, listener);
    if (refused != null) listener.settled(id, Outcome.failed(refused), null);
    return new Call(this, NATIVE_OWNER, id);
  }

  public PushResult pushCredential(CredentialPush push) throws IOException {
    Path target;
    String token;
    synchronized (policy) {
      if (!policy.serving()) throw new NotServing();
      target = socket;
      token = policy.rootToken();
    }
    return client.pushCredential(target, token, push);
  }

  private static Map<String, ?> named(Map<String, ?> headers) { return headers == null ? Map.of() : headers; }

  private FailCode begin(Step step, Listener listener, Outgoing outgoing) {
    for (Out out : step.out()) {
      if (out instanceof Refused refused) return refused.code();
      if (out instanceof Accepted accepted) {
        Path target = socket;
        String token = policy.rootToken();
        Live call = new Live(accepted.seq(), accepted.id(), listener);
        live.put(call.seq, call);
        calls.execute(() -> run(call, target, token, outgoing));
        return null;
      }
    }
    return FailCode.NOT_READY;
  }

  private void run(Live call, Path target, String token, Outgoing outgoing) {
    try {
      client.exchange(target, token, call.id, outgoing, call::attach, frame -> {
        synchronized (call) {
          if (call.ended) return false;
          dispatch(call, policy.reply(call.seq, policyFrame(call, frame)), frame);
          return !call.ended;
        }
      });
    } catch (IOException | IllegalArgumentException lost) {
      call.end();
    } finally {
      synchronized (call) { if (live.containsKey(call.seq)) dispatch(call, policy.lost(call.seq), null); }
    }
  }

  private static ChannelPolicy.Frame policyFrame(Live call, Frame frame) {
    if (frame instanceof Result result) {
      call.result = result;
      return new ChannelPolicy.Frame(FrameKind.RESULT, result.status());
    }
    if (frame instanceof Head head) return new ChannelPolicy.Frame(FrameKind.HEAD, head.status());
    if (frame instanceof Chunk) return ChannelPolicy.Frame.of(FrameKind.CHUNK);
    if (frame instanceof Complete complete) return ChannelPolicy.Frame.of(complete.error() == null ? FrameKind.COMPLETE : FrameKind.COMPLETE_FAILED);
    if (frame instanceof Subscribed) return ChannelPolicy.Frame.of(FrameKind.SUBSCRIBED);
    if (frame instanceof Event) return ChannelPolicy.Frame.of(FrameKind.AGENT_EVENT);
    if (frame instanceof Refusal) return ChannelPolicy.Frame.of(FrameKind.REFUSAL);
    throw new IllegalStateException("unknown agent frame");
  }

  private void settleLive(Settled settled) {
    Live call = live.get(settled.seq());
    if (call == null) return;
    synchronized (call) { dispatch(call, new Step(true, List.of(settled)), null); }
  }

  private void dispatch(Live call, Step step, Frame frame) {
    for (Out out : step.out()) {
      if (out instanceof Delivered delivered) deliver(call, delivered.index(), frame);
      else if (out instanceof Settled settled) {
        live.remove(call.seq);
        call.end();
        byte[] body = settled.outcome().kind() == OutcomeKind.RESPONSE && call.result != null ? call.result.body() : null;
        call.listener.settled(call.id, settled.outcome(), body);
      }
    }
  }

  private static void deliver(Live call, long index, Frame frame) {
    if (frame instanceof Head head) call.listener.head(call.id, index, head.status(), head.headers());
    else if (frame instanceof Chunk chunk) {
      call.listener.chunk(call.id, index, chunk.data());
      for (String data : chunk.events()) call.listener.eventData(call.id, data);
    } else if (frame instanceof Event event) call.listener.event(call.id, index, event.event());
  }
}
