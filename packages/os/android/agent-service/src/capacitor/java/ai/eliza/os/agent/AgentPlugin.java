// spec/os/agentService/channel.md, "Story: Ask the agent only on the routes my app allows"; spec/os/agentService/channel.md, "Story: Stream a reply and stop it"; spec/os/agentService/channel.md, "Story: Receive the agent's live events for my screen"; spec/os/agentService/lifecycle.md, "Story: Start the agent after checking its payload"; spec/os/agentService/lifecycle.md, "Story: Recover my agent's records after a storage failure"
package ai.eliza.os.agent;

import ai.eliza.os.agent.ChannelPolicy.FailCode;
import ai.eliza.os.agent.ChannelPolicy.Outcome;
import ai.eliza.os.agent.ChannelPolicy.Topic;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

@CapacitorPlugin(name = "ElizaAgent")
public class AgentPlugin extends Plugin {
  private final String owner = "screen-" + UUID.randomUUID();
  private AutoCloseable observation;

  @Override public void load() {
    observation = AgentService.observe(() -> notifyListeners("status", status()));
  }

  @PluginMethod public void getStatus(PluginCall call) { call.resolve(status()); }

  @PluginMethod public void start(PluginCall call) { command(call, () -> AgentService.start(getContext())); }

  @PluginMethod public void stop(PluginCall call) { command(call, () -> AgentService.stop(getContext())); }

  @PluginMethod public void restart(PluginCall call) { command(call, () -> AgentService.restart(getContext())); }

  @PluginMethod public void request(PluginCall call) {
    String id = call.getString("id", "");
    FailCode refused = ask(call, id.isEmpty() ? UUID.randomUUID().toString() : id, false, new Listener() {
      @Override public void settled(String callId, Outcome outcome, byte[] body) {
        if (outcome.kind() == ChannelPolicy.OutcomeKind.RESPONSE) call.resolve(response(outcome.status(), body));
        else reject(call, outcome.kind() == ChannelPolicy.OutcomeKind.FAILED ? outcome.code() : FailCode.BROKEN);
      }
    });
    if (refused != null) reject(call, refused);
  }

  @PluginMethod public void requestStream(PluginCall call) {
    String id = call.getString("id", "");
    FailCode refused = ask(call, id, true, new Listener() {
      @Override public void head(String callId, long index, int status, Map<String, String> headers) {
        JSObject head = frame(callId, "head", index);
        head.put("status", status);
        JSObject named = new JSObject();
        headers.forEach(named::put);
        head.put("headers", named);
        notifyListeners("streamData", head);
      }
      @Override public void chunk(String callId, long index, byte[] data) {
        JSObject chunk = frame(callId, "chunk", index);
        chunk.put("dataBase64", Base64.getEncoder().encodeToString(data));
        notifyListeners("streamData", chunk);
      }
      @Override public void settled(String callId, Outcome outcome, byte[] body) { notifyListeners("streamEnd", ending(callId, outcome)); }
    });
    if (refused != null) reject(call, refused);
    else call.resolve(new JSObject().put("id", id));
  }

  @PluginMethod public void abort(PluginCall call) {
    call.resolve(new JSObject().put("aborted", AgentService.channel().abort(owner, call.getString("id", ""))));
  }

  @PluginMethod public void subscribeEvents(PluginCall call) {
    String id = call.getString("id", "");
    Topic topic = topic(call.getString("topic", ""));
    FailCode refused = topic == null ? FailCode.ROUTE_REFUSED : AgentService.channel().subscribe(owner, id, topic, call.getString("clientId", owner), new Listener() {
      @Override public void event(String callId, long index, JSONObject event) {
        JSObject heard = frame(callId, "event", index);
        heard.put("event", event);
        notifyListeners("agentEvent", heard);
      }
      @Override public void settled(String callId, Outcome outcome, byte[] body) { notifyListeners("agentEvent", ending(callId, outcome)); }
    });
    if (refused != null) reject(call, refused);
    else call.resolve(new JSObject().put("id", id));
  }

  @PluginMethod public void unsubscribeEvents(PluginCall call) { abort(call); }

  @PluginMethod public void reviewRecovery(PluginCall call) {
    AgentService.Review review = AgentService.reviewRecovery(getContext());
    JSObject answer = new JSObject();
    if (review == null) answer.put("kind", "unavailable");
    else answer.put("kind", "reviewable").put("reviewToken", review.token()).put("retainedCount", review.retainedCount());
    call.resolve(answer);
  }

  @PluginMethod public void archiveRecovery(PluginCall call) {
    int archived = AgentService.archiveRecovery(getContext(), call.getString("reviewToken", ""));
    JSObject answer = new JSObject();
    if (archived < 0) answer.put("kind", "unavailable");
    else answer.put("kind", "archived").put("archivedCount", archived);
    call.resolve(answer);
  }

  @Override protected void handleOnDestroy() {
    AgentService.channel().abandon(owner);
    if (observation != null) try { observation.close(); } catch (Exception ignored) { }
  }

  private JSObject status() {
    try { return JSObject.fromJSONObject(AgentService.status(getContext())); }
    catch (JSONException impossible) { throw new IllegalStateException(impossible); }
  }

  private void command(PluginCall call, Runnable action) {
    try { action.run(); }
    catch (IllegalStateException refused) { call.reject(refused.getMessage()); return; }
    call.resolve(status());
  }

  private FailCode ask(PluginCall call, String id, boolean streamed, AgentChannel.Listener listener) {
    Object body = call.getData().opt("body");
    String text = body == null || body == JSONObject.NULL ? null : body instanceof String plain ? JSONObject.quote(plain) : body.toString();
    byte[] bytes = text == null ? null : text.getBytes(StandardCharsets.UTF_8);
    return AgentService.channel().ask(owner, id, call.getString("method", ""), call.getString("path", ""), streamed, bytes, listener);
  }

  private static Topic topic(String name) {
    return switch (name) { case "voice" -> Topic.VOICE; case "view" -> Topic.VIEW; default -> null; };
  }

  private static String name(FailCode code) {
    return switch (code) {
      case NOT_READY -> "NotReady"; case ROUTE_REFUSED -> "RouteRefused"; case TOO_LARGE -> "TooLarge"; case ID_IN_USE -> "IdInUse";
      case TOPIC_IN_USE -> "TopicInUse"; case BUSY -> "Busy"; case RESTARTED -> "Restarted"; case BROKEN -> "Broken";
    };
  }

  private static void reject(PluginCall call, FailCode code) { call.reject(name(code), name(code)); }

  private static JSObject frame(String id, String kind, long index) {
    return new JSObject().put("id", id).put("kind", kind).put("index", index);
  }

  private static JSObject ending(String id, Outcome outcome) {
    JSObject end = new JSObject().put("id", id);
    return switch (outcome.kind()) {
      case FAILED -> end.put("kind", "failed").put("code", name(outcome.code()));
      case ERROR -> end.put("kind", "error");
      case ABORTED -> end.put("kind", "aborted");
      case END, RESPONSE -> end.put("kind", "end");
    };
  }

  private static JSObject response(long status, byte[] body) {
    JSObject answer = new JSObject().put("status", status);
    String text = body == null ? "" : new String(body, StandardCharsets.UTF_8);
    Object data = JSONObject.NULL;
    if (!text.isEmpty()) {
      try { data = new JSONTokener(text).nextValue(); } catch (JSONException notJson) { data = text; }
    }
    return answer.put("data", data);
  }

  private abstract static class Listener implements AgentChannel.Listener {
    @Override public void head(String id, long index, int status, Map<String, String> headers) { }
    @Override public void chunk(String id, long index, byte[] data) { }
    @Override public void event(String id, long index, JSONObject event) { }
  }
}
