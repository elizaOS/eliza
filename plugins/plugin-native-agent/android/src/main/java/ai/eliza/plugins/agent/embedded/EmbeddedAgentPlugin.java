package ai.eliza.plugins.agent.embedded;

import ai.eliza.plugins.agent.runtime.NativeRuntimeSession;
import ai.eliza.plugins.agent.runtime.RuntimeRequestDispatcher;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

/** The page's only way to the embedded agent. Every request is checked against the consumer's
 * route list before any I/O, and talks to the agent over its private loopback socket, so the
 * page needs no cleartext network access and never holds a token or credential. */
@CapacitorPlugin(name = "EmbeddedAgent")
public final class EmbeddedAgentPlugin extends Plugin {
  private final RuntimeRequestDispatcher requests = new RuntimeRequestDispatcher();
  private final ConcurrentHashMap<String, Socket> streams = new ConcurrentHashMap<>();
  private Class<? extends EmbeddedAgentService> service;
  private AutoCloseable observation;

  @Override public void load() {
    try {
      service = EmbeddedAgentService.serviceClass(getContext());
      observation = EmbeddedAgentService.observe(service, () -> {
        try { notifyListeners("status", JSObject.fromJSONObject(EmbeddedAgentService.status(getContext(), service))); }
        catch (Exception unavailable) { notifyListeners("status", unconfigured()); }
      });
    } catch (IOException unconfigured) { service = null; }
  }

  private static JSObject unconfigured() {
    JSObject status = new JSObject();
    status.put("available", false); status.put("state", "unavailable"); status.put("failure", "config");
    return status;
  }

  @PluginMethod public void getStatus(PluginCall call) {
    if (service == null) { call.resolve(unconfigured()); return; }
    try { call.resolve(JSObject.fromJSONObject(EmbeddedAgentService.status(getContext(), service))); }
    catch (Exception failure) { call.reject("The agent status is unavailable"); }
  }
  @PluginMethod public void start(PluginCall call) { command(call, null); }
  @PluginMethod public void restart(PluginCall call) { command(call, "restart"); }
  @PluginMethod public void stop(PluginCall call) { command(call, "stop"); }

  private void command(PluginCall call, String action) {
    if (service == null) { call.resolve(unconfigured()); return; }
    try {
      if ("restart".equals(action)) EmbeddedAgentService.prepareRestart(service);
      Intent intent = new Intent(getContext(), service).setAction(action);
      if ("stop".equals(action)) getContext().stopService(intent);
      else if (EmbeddedAgentService.payloadAvailable(getContext())) getContext().startForegroundService(intent);
      call.resolve(JSObject.fromJSONObject(EmbeddedAgentService.status(getContext(), service)));
    } catch (Exception refused) { call.reject("The agent could not be started"); }
  }

  @PluginMethod public void request(PluginCall call) {
    String method = call.getString("method", "GET"), path = call.getString("path", "");
    JSObject body = call.getObject("body");
    if (!admitted(call, method, path, false)) return;
    String text = body == null ? null : body.toString();
    dispatch(call, path, text, () -> {
      try { call.resolve(JSObject.fromJSONObject(EmbeddedAgentService.request(service, method, path, text))); }
      catch (Exception failure) { reject(call, failure); }
    });
  }

  @PluginMethod public void requestStream(PluginCall call) {
    String method = call.getString("method", "POST"), path = call.getString("path", "");
    JSObject body = call.getObject("body");
    String id = call.getString("id", "");
    if (!id.matches("[A-Za-z0-9-]{8,64}") || streams.containsKey(id)) { call.reject("A new stream id is required", "INVALID_STREAM_ID"); return; }
    if (!admitted(call, method, path, true)) return;
    String text = body == null ? null : body.toString();
    Socket socket = new Socket();
    streams.put(id, socket);
    boolean accepted = dispatch(call, path, text, () -> {
      JSObject end = new JSObject();
      end.put("id", id);
      try {
        JSONObject result = EmbeddedAgentService.stream(service, socket, method, path, text, data -> {
          JSObject event = new JSObject();
          event.put("id", id); event.put("data", data);
          notifyListeners("streamData", event);
        });
        end.put("status", result.getInt("status"));
        if (result.has("data")) end.put("data", result.get("data"));
      } catch (Exception failure) {
        if (socket.isClosed() && !streams.containsKey(id)) end.put("aborted", true);
        else end.put("error", failure instanceof IOException ? failure.getMessage() : "The agent request failed");
        if (failure instanceof NativeRuntimeSession.NotReadyException) end.put("code", NativeRuntimeSession.NotReadyException.CODE);
      } finally {
        streams.remove(id);
        try { socket.close(); } catch (IOException ignored) { }
        notifyListeners("streamEnd", end);
      }
    });
    if (!accepted) { streams.remove(id); return; }
    JSObject started = new JSObject();
    started.put("id", id);
    call.resolve(started);
  }

  @PluginMethod public void abort(PluginCall call) {
    Socket socket = streams.remove(call.getString("id", ""));
    JSObject result = new JSObject();
    result.put("aborted", socket != null);
    if (socket != null) try { socket.close(); } catch (IOException ignored) { }
    call.resolve(result);
  }

  private boolean admitted(PluginCall call, String method, String path, boolean stream) {
    EmbeddedAgentConfig.Route route;
    try { route = service == null ? null : EmbeddedAgentService.config(getContext()).admit(method, path); }
    catch (IOException unconfigured) { route = null; }
    if (route == null || route.stream != stream) { call.reject("This agent route is not available", "ROUTE_REFUSED"); return false; }
    return true;
  }
  private boolean dispatch(PluginCall call, String path, String body, Runnable work) {
    RuntimeRequestDispatcher.Admission admission = requests.submit(path, body == null ? 0 : body.length(), work);
    if (admission == RuntimeRequestDispatcher.Admission.TOO_LARGE) call.reject("The agent request is too large", "TOO_LARGE");
    else if (admission == RuntimeRequestDispatcher.Admission.BUSY) call.reject("The agent is busy; try again", "BUSY");
    return admission == RuntimeRequestDispatcher.Admission.ACCEPTED;
  }
  private static void reject(PluginCall call, Exception failure) {
    if (failure instanceof NativeRuntimeSession.NotReadyException) call.reject(failure.getMessage(), NativeRuntimeSession.NotReadyException.CODE);
    else call.reject(failure instanceof IOException ? failure.getMessage() : "The agent request failed");
  }

  @Override protected void handleOnDestroy() {
    requests.close();
    for (Socket socket : streams.values()) try { socket.close(); } catch (IOException ignored) { }
    streams.clear();
    if (observation != null) try { observation.close(); } catch (Exception ignored) { }
  }
}
