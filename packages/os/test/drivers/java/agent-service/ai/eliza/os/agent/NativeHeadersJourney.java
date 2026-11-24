// spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"
package ai.eliza.os.agent;

import ai.eliza.os.agent.AgentSocketClient.Link;
import ai.eliza.os.agent.ChannelPolicy.CallerKind;
import ai.eliza.os.agent.ChannelPolicy.OutcomeKind;
import ai.eliza.os.agent.RouteGate.Delivery;
import ai.eliza.os.agent.RouteGate.Group;
import ai.eliza.os.agent.RouteGate.Method;
import ai.eliza.os.agent.RouteGate.Piece;
import ai.eliza.os.agent.RouteGate.Route;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Sends native calls through a real AgentChannel and AgentSocketClient to an in-memory agent socket, and prints one
 * JSON line per observation: which headers reached the socket frame, and which calls were refused before any I/O.
 */
public final class NativeHeadersJourney {
  private NativeHeadersJourney() {}

  private static final String ROOT_TOKEN = "root-token-for-the-journey";
  private static final String PROPOSALS = "/api/device-actions/proposals";
  private static final String KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  private interface JsonWork<T> { T get() throws JSONException; }

  private static <T> T json(JsonWork<T> work) {
    try { return work.get(); } catch (JSONException invalid) { throw new IllegalStateException(invalid); }
  }

  private static void emit(String step, Object value) {
    System.out.println(json(() -> new JSONObject().put("step", step).put("value", value == null ? JSONObject.NULL : value)));
  }

  /** The agent's side of the socket: records each request frame and answers it as the transport does. */
  private static final class Agent implements AgentSocketClient.Connector {
    final List<JSONObject> frames = new CopyOnWriteArrayList<>();

    @Override public Link connect(Path socket) {
      ByteArrayOutputStream written = new ByteArrayOutputStream();
      return new Link() {
        @Override public InputStream input() {
          return new InputStream() {
            private byte[] answer;
            private int at;
            @Override public int read() {
              if (answer == null) answer = answer(written);
              return at < answer.length ? answer[at++] & 0xff : -1;
            }
          };
        }
        @Override public OutputStream output() { return written; }
        @Override public void close() { }
      };
    }

    private byte[] answer(ByteArrayOutputStream written) {
      String line = new String(written.toByteArray(), StandardCharsets.UTF_8).trim();
      JSONObject frame = json(() -> new JSONObject(line));
      frames.add(frame);
      String id = frame.optString("id");
      String text = json(() -> "http_request_stream".equals(frame.getString("method"))
        ? new JSONObject().put("id", id).put("stream", "response").put("status", 200).put("headers", new JSONObject()) + "\n"
          + new JSONObject().put("id", id).put("stream", "complete") + "\n"
        : new JSONObject().put("id", id).put("ok", true).put("result", new JSONObject().put("status", 201).put("headers", new JSONObject()).put("body", "{}")) + "\n");
      return text.getBytes(StandardCharsets.UTF_8);
    }

    JSONObject last() { return frames.isEmpty() ? null : frames.get(frames.size() - 1); }
  }

  private static List<Group> nativeRoutes() {
    List<Piece> path = List.of(new Piece("api"), new Piece("device-actions"), new Piece("proposals"));
    return List.of(new Group(List.of(List.of("api", "device-actions")), "", List.of(
      new Route(Method.POST, Delivery.BUFFERED, path, List.of(), null),
      new Route(Method.POST, Delivery.STREAMED, path, List.of(), null))));
  }

  private static Object headersOf(JSONObject frame) {
    return frame == null ? null : json(() -> frame.getJSONObject("payload").getJSONObject("headers"));
  }

  private static Object answered(CompletableFuture<AgentChannel.Response> pending) {
    try {
      return pending.get(10, TimeUnit.SECONDS).status();
    } catch (ExecutionException failed) {
      return failed.getCause() instanceof AgentChannel.Unanswered unanswered && unanswered.outcome().kind() == OutcomeKind.FAILED
        ? unanswered.outcome().code().name() : String.valueOf(failed.getCause());
    } catch (Exception unexpected) {
      return String.valueOf(unexpected);
    }
  }

  private static Object streamed(AgentChannel channel, Map<String, ?> headers) throws InterruptedException {
    CompletableFuture<String> ended = new CompletableFuture<>();
    channel.requestStream(CallerKind.NATIVE, "POST", PROPOSALS, "{}".getBytes(StandardCharsets.UTF_8), headers, new AgentChannel.Listener() {
      @Override public void head(String id, long index, int status, Map<String, String> head) { }
      @Override public void chunk(String id, long index, byte[] data) { }
      @Override public void event(String id, long index, JSONObject event) { }
      @Override public void settled(String id, ChannelPolicy.Outcome outcome, byte[] body) {
        ended.complete(outcome.kind() == OutcomeKind.FAILED ? outcome.code().name() : outcome.kind().name());
      }
    });
    try { return ended.get(10, TimeUnit.SECONDS); } catch (ExecutionException | java.util.concurrent.TimeoutException unexpected) { return String.valueOf(unexpected); }
  }

  public static void main(String[] args) throws Exception {
    Agent agent = new Agent();
    ChannelPolicy policy = new ChannelPolicy();
    AgentChannel channel = new AgentChannel(policy, new AgentSocketClient(agent, System::nanoTime));
    policy.loadRoutes(CallerKind.NATIVE, nativeRoutes());
    emit("opened", channel.open(1, ROOT_TOKEN, Path.of("agent.sock")));
    byte[] body = "{\"kind\":\"call\"}".getBytes(StandardCharsets.UTF_8);

    emit("plain-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body)));
    emit("plain-headers", headersOf(agent.last()));

    Map<String, Object> device = new LinkedHashMap<>();
    device.put("X-ElizaOS-Client-Id", "phone-client-1");
    device.put("X-Eliza-Device-Id", "device-1");
    device.put("X-Eliza-Device-Capabilities", "sms,call");
    device.put("x-eliza-device-key", KEY);
    emit("device-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, device)));
    emit("device-headers", headersOf(agent.last()));
    emit("device-method", json(() -> agent.last().getString("method")));

    emit("stream-outcome", streamed(channel, Map.of("x-elizaos-client-id", "phone-client-1")));
    emit("stream-headers", headersOf(agent.last()));
    emit("stream-method", json(() -> agent.last().getString("method")));

    int before = agent.frames.size();
    emit("credential-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, Map.of("x-eliza-device-token", "secret"))));
    emit("authorization-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, Map.of("Authorization", "Bearer other"))));
    emit("short-key-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, Map.of("x-eliza-device-key", "abc"))));
    emit("unprintable-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, Map.of("x-eliza-device-id", "line\nbreak"))));
    Map<String, Object> many = new LinkedHashMap<>();
    for (int i = 0; i < ChannelPolicy.HEADER_COUNT_LIMIT + 1; i++) many.put("x-eliza-device-fact" + (char) ('a' + i), "v");
    emit("too-many-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, many)));
    emit("refused-stream-outcome", streamed(channel, Map.of("cookie", "a=b")));
    emit("refused-frames-sent", agent.frames.size() - before);

    emit("null-headers-status", answered(channel.request(CallerKind.NATIVE, "POST", PROPOSALS, body, null)));
    emit("null-headers", headersOf(agent.last()));
    System.exit(0);
  }
}
