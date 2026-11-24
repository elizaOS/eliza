// spec/os/agentService/channel.md, "The launch's root token stays inside the service"; spec/os/agentService/channel.md, "The token is written only to a socket whose peer is this app"; spec/os/agentService/channel.md, "Only the device headers and client id the runtime client carries cross the channel"; spec/os/agentService/channel.md, "A pending call settles exactly once, and nothing else leaves the pending list"; spec/agent/access/transport.md, "A request gets 10 seconds, or 600 on a message, speech or stream route"; spec/agent/models/binding.md, "A pushed credential replaces the key only at a higher version of the launch account, and needs no restart"
package ai.eliza.os.agent;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.SystemClock;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class AgentSocketClient {
  public static final int FRAME_LIMIT = 25_165_824;
  public static final int SHORT_DEADLINE_MS = 10_000, LONG_DEADLINE_MS = 600_000, DEADLINE_GRACE_MS = 2_000;
  public static final String CREDENTIAL_ROUTE = "/api/host/cloud-credential";
  private static final Pattern MESSAGE_ROUTE = Pattern.compile("^/api/conversations/[^/]+/messages(?:/stream)?$");
  private static final Pattern SPEECH_ROUTE = Pattern.compile("^/api/asr/local-inference(?:/|$)");
  private static final ScheduledThreadPoolExecutor TIMERS = new ScheduledThreadPoolExecutor(1, task -> {
    Thread thread = new Thread(task, "AgentSocketDeadline");
    thread.setDaemon(true);
    return thread;
  });
  static { TIMERS.setRemoveOnCancelPolicy(true); }

  public interface Link extends AutoCloseable {
    InputStream input() throws IOException;
    OutputStream output() throws IOException;
    @Override void close();
  }

  @FunctionalInterface public interface Connector { Link connect(Path socket) throws IOException; }

  @FunctionalInterface public interface Sink { boolean accept(Frame frame); }

  public sealed interface Frame permits Result, Refusal, Head, Chunk, Complete, Subscribed, Event {}
  public record Result(int status, Map<String, String> headers, byte[] body) implements Frame {}
  public record Refusal(String error) implements Frame {}
  public record Head(int status, Map<String, String> headers) implements Frame {}
  public record Chunk(byte[] data, List<String> events) implements Frame {}
  public record Complete(String error) implements Frame {}
  public record Subscribed() implements Frame {}
  public record Event(JSONObject event) implements Frame {}

  public sealed interface Outgoing permits HttpCall, Subscription {}
  public record HttpCall(String method, String path, byte[] body, boolean streamed, Map<String, String> headers) implements Outgoing {
    public HttpCall(String method, String path, byte[] body, boolean streamed) {
      this(method, path, body, streamed, Map.of());
    }
  }
  public record Subscription(List<String> streams, String clientId) implements Outgoing {}

  public record Account(String userId, String organizationId) {}
  public record CredentialPush(long version, String credential, long expiresAt, Account account) {}
  public sealed interface PushResult permits PushAccepted, PushRefused, PushFailed {}
  public record PushAccepted() implements PushResult {}
  public record PushRefused(String reason) implements PushResult {}
  public record PushFailed(int status) implements PushResult {}

  private final Connector connector;
  private final LongSupplier clock;

  public AgentSocketClient(Connector connector, LongSupplier clock) {
    this.connector = Objects.requireNonNull(connector);
    this.clock = Objects.requireNonNull(clock);
  }

  public static AgentSocketClient android() {
    return new AgentSocketClient(AgentSocketClient::localSocket, SystemClock::elapsedRealtimeNanos);
  }

  private static Link localSocket(Path path) throws IOException {
    LocalSocket socket = new LocalSocket();
    try {
      socket.connect(new LocalSocketAddress(path.toString(), LocalSocketAddress.Namespace.FILESYSTEM));
      Integer peer;
      try { peer = socket.getPeerCredentials().getUid(); } catch (IOException unread) { peer = null; }
      if (!ChannelPolicy.peerTrusted(peer, android.os.Process.myUid())) throw new IOException("The agent socket's peer is not this app");
    } catch (IOException refused) {
      socket.close();
      throw refused;
    }
    return new Link() {
      @Override public InputStream input() throws IOException { return socket.getInputStream(); }
      @Override public OutputStream output() throws IOException { return socket.getOutputStream(); }
      @Override public void close() { try { socket.close(); } catch (IOException ignored) { } }
    };
  }

  public static int deadlineMs(Outgoing outgoing) {
    if (!(outgoing instanceof HttpCall call)) return 0;
    String path = call.path().split("\\?", 2)[0];
    boolean plain = !MESSAGE_ROUTE.matcher(path).find() && !SPEECH_ROUTE.matcher(path).find();
    return (call.streamed() || !plain ? LONG_DEADLINE_MS : SHORT_DEADLINE_MS) + DEADLINE_GRACE_MS;
  }

  public void exchange(Path socket, String token, String id, Outgoing outgoing, Consumer<Link> attach, Sink sink) throws IOException {
    int deadlineMs = deadlineMs(outgoing);
    try (Link link = connector.connect(socket); Deadline deadline = new Deadline(link, deadlineMs, clock)) {
      attach.accept(link);
      byte[] request = (frameOf(token, id, outgoing).toString() + "\n").getBytes(StandardCharsets.UTF_8);
      if (request.length > FRAME_LIMIT) throw new IOException("agent request frame over the limit");
      OutputStream output = link.output();
      output.write(request);
      output.flush();
      deadline.check();
      read(new BufferedInputStream(link.input()), id, outgoing instanceof Subscription, deadline, sink);
    } catch (JSONException malformed) {
      throw new IOException("agent frame is not the transport's", malformed);
    }
  }

  public PushResult pushCredential(Path socket, String token, CredentialPush push) throws IOException {
    JSONObject body;
    try {
      body = new JSONObject()
        .put("version", push.version())
        .put("credential", push.credential())
        .put("expiresAt", push.expiresAt())
        .put("account", new JSONObject().put("userId", push.account().userId()).put("organizationId", push.account().organizationId()));
    } catch (JSONException unwritable) {
      throw new IOException("credential push is not writable", unwritable);
    }
    List<Frame> answer = new ArrayList<>(1);
    HttpCall call = new HttpCall("PUT", CREDENTIAL_ROUTE, body.toString().getBytes(StandardCharsets.UTF_8), false, Map.of());
    exchange(socket, token, "credential-" + push.version(), call, link -> { }, frame -> { answer.add(frame); return false; });
    if (answer.isEmpty()) throw new IOException("agent closed the connection before answering the credential push");
    Frame frame = answer.get(0);
    if (frame instanceof Refusal refusal) throw new IOException("agent refused the credential push frame: " + refusal.error());
    if (!(frame instanceof Result result)) throw new IOException("agent answered the credential push with a stream frame");
    if (result.status() >= 200 && result.status() < 300) return new PushAccepted();
    if (result.status() == 409) return new PushRefused(reasonOf(result.body()));
    return new PushFailed(result.status());
  }

  private static String reasonOf(byte[] body) {
    String text = new String(body, StandardCharsets.UTF_8);
    try {
      JSONObject parsed = new JSONObject(text);
      String reason = parsed.optString("reason", "");
      return reason.isEmpty() ? parsed.optString("error", text) : reason;
    } catch (JSONException notJson) {
      return text;
    }
  }

  private static JSONObject frameOf(String token, String id, Outgoing outgoing) throws JSONException {
    JSONObject headers = new JSONObject().put("authorization", "Bearer " + token);
    if (outgoing instanceof HttpCall call) {
      for (Map.Entry<String, String> carried : call.headers().entrySet()) headers.put(carried.getKey(), carried.getValue());
      JSONObject payload = new JSONObject().put("path", call.path()).put("method", call.method()).put("headers", headers);
      if (call.body() != null) {
        headers.put("content-type", "application/json");
        payload.put("bodyBase64", Base64.getEncoder().encodeToString(call.body()));
      }
      return new JSONObject().put("id", id).put("method", call.streamed() ? "http_request_stream" : "http_request").put("payload", payload);
    }
    Subscription subscription = (Subscription) outgoing;
    JSONObject payload = new JSONObject().put("streams", new JSONArray(subscription.streams())).put("headers", headers);
    if (subscription.clientId() != null) payload.put("clientId", subscription.clientId());
    return new JSONObject().put("id", id).put("method", "events_subscribe").put("payload", payload);
  }

  private static void read(InputStream input, String id, boolean feed, Deadline deadline, Sink sink) throws IOException, JSONException {
    Sse sse = null;
    while (true) {
      JSONObject line = line(input);
      deadline.check();
      Frame frame;
      if (feed && line.has("type")) {
        frame = switch (line.getString("type")) {
          case "subscribed" -> new Subscribed();
          case "event" -> new Event(line.getJSONObject("event"));
          default -> throw new IOException("agent sent an unknown feed frame");
        };
      } else {
        if (!id.equals(line.optString("id"))) throw new IOException("agent answered another call");
        if (line.has("ok")) {
          frame = line.getBoolean("ok") ? result(line.getJSONObject("result")) : new Refusal(line.optString("error", ""));
        } else {
          frame = switch (line.getString("stream")) {
            case "response" -> {
              Head head = new Head(line.getInt("status"), headers(line.optJSONObject("headers")));
              if (head.headers().getOrDefault("content-type", "").startsWith("text/event-stream")) sse = new Sse();
              yield head;
            }
            case "chunk" -> {
              byte[] data = Base64.getDecoder().decode(line.getString("dataBase64"));
              yield new Chunk(data, sse == null ? List.of() : sse.feed(data));
            }
            case "complete" -> new Complete(line.has("error") ? line.optString("error", "stream_failed")
              : sse != null && !sse.finished() ? "incomplete_event" : null);
            default -> throw new IOException("agent sent an unknown stream frame");
          };
        }
      }
      if (!sink.accept(frame)) return;
    }
  }

  private static Result result(JSONObject result) throws JSONException {
    Object encoded = result.opt("bodyBase64");
    byte[] body = encoded instanceof String base64 ? Base64.getDecoder().decode(base64)
      : result.optString("body", "").getBytes(StandardCharsets.UTF_8);
    return new Result(result.getInt("status"), headers(result.optJSONObject("headers")), body);
  }

  private static Map<String, String> headers(JSONObject headers) throws JSONException {
    Map<String, String> out = new LinkedHashMap<>();
    if (headers == null) return out;
    for (var keys = headers.keys(); keys.hasNext();) {
      String key = keys.next();
      out.put(key.toLowerCase(java.util.Locale.ROOT), headers.getString(key));
    }
    return out;
  }

  private static JSONObject line(InputStream input) throws IOException, JSONException {
    ByteArrayOutputStream data = new ByteArrayOutputStream();
    for (int value; (value = input.read()) >= 0;) {
      if (value == '\n') return new JSONObject(new String(data.toByteArray(), StandardCharsets.UTF_8));
      if (data.size() >= FRAME_LIMIT) throw new IOException("agent frame over the limit");
      data.write(value);
    }
    throw new IOException("agent closed the connection");
  }

  static final class Sse {
    private final ByteArrayOutputStream line = new ByteArrayOutputStream();
    private final StringBuilder event = new StringBuilder();
    private boolean pending;

    List<String> feed(byte[] bytes) throws IOException {
      List<String> events = new ArrayList<>();
      for (byte value : bytes) {
        if (value != '\n') {
          line.write(value);
          if (line.size() + event.length() > FRAME_LIMIT) throw new IOException("agent event over the limit");
          continue;
        }
        String text = new String(line.toByteArray(), StandardCharsets.UTF_8);
        line.reset();
        if (text.endsWith("\r")) text = text.substring(0, text.length() - 1);
        if (text.isEmpty()) {
          if (pending) events.add(event.toString());
          event.setLength(0);
          pending = false;
        } else if (text.startsWith("data:")) {
          if (pending) event.append('\n');
          event.append(text.substring(text.startsWith("data: ") ? 6 : 5));
          pending = true;
        }
      }
      return events;
    }

    boolean finished() { return line.size() == 0 && !pending; }
  }

  private static final class Deadline implements AutoCloseable {
    private final Link link;
    private final LongSupplier clock;
    private final long started, budget;
    private final AtomicBoolean expired = new AtomicBoolean();
    private final ScheduledFuture<?> timer;

    Deadline(Link link, int deadlineMs, LongSupplier clock) {
      this.link = link;
      this.clock = clock;
      started = clock.getAsLong();
      budget = deadlineMs == 0 ? Long.MAX_VALUE : TimeUnit.MILLISECONDS.toNanos(deadlineMs);
      timer = deadlineMs == 0 ? null : TIMERS.schedule(this::expire, deadlineMs, TimeUnit.MILLISECONDS);
    }

    private void expire() {
      expired.set(true);
      link.close();
    }

    void check() throws SocketTimeoutException {
      long elapsed = clock.getAsLong() - started;
      if (expired.get() || elapsed < 0 || elapsed >= budget) {
        expire();
        throw new SocketTimeoutException("agent call deadline passed");
      }
    }

    @Override public void close() { if (timer != null) timer.cancel(false); }
  }
}
