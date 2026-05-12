package ai.elizaos.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@CapacitorPlugin(name = "Agent")
public class AgentPlugin extends Plugin {
    private static final String LOCAL_AGENT_BASE_URL = "http://127.0.0.1:31337";
    private static final int DEFAULT_TIMEOUT_MS = 10_000;
    private static final int MIN_TIMEOUT_MS = 1_000;
    private static final int MAX_TIMEOUT_MS = 120_000;
    private static final int MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
    private static final int MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

    @PluginMethod
    public void start(PluginCall call) {
        try {
            ElizaAgentService.start(getContext());
            call.resolve(status("starting", null));
        } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "Failed to start local agent");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            ElizaAgentService.stop(getContext());
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() != null ? error.getMessage() : "Failed to stop local agent");
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        final String token = readLocalAgentToken();
        if (token == null) {
            call.resolve(status("not_started", null));
            return;
        }

        new Thread(() -> {
            try {
                JSObject result = forwardLocalRequest("/api/status", "GET", new JSObject(), null, 1500, token);
                String body = result.getString("body", "{}");
                JSONObject json = new JSONObject(body);
                String state = json.optString("state", "running");
                String error = json.optString("error", "").trim();
                call.resolve(status(state, error.isEmpty() ? null : error));
            } catch (Exception error) {
                call.resolve(status("error", error.getMessage() != null ? error.getMessage() : "Local agent status unavailable"));
            }
        }, "eliza-agent-status").start();
    }

    @PluginMethod
    public void getLocalAgentToken(PluginCall call) {
        String token = readLocalAgentToken();
        JSObject result = new JSObject();
        result.put("available", token != null);
        result.put("token", token != null ? token : JSONObject.NULL);
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        String path = trimToNull(call.getString("path"));
        if (path == null || !path.startsWith("/") || path.startsWith("//") || hasUrlScheme(path)) {
            call.reject("Agent.request requires a local path that starts with / and is not an absolute URL");
            return;
        }

        String requestedMethod = trimToNull(call.getString("method"));
        final String method = requestedMethod == null
            ? "GET"
            : requestedMethod.toUpperCase(Locale.US);
        if (!method.matches("^[A-Z]{1,16}$")) {
            call.reject("Unsupported HTTP method");
            return;
        }

        int timeoutMs = clampTimeout(call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS));
        String body = call.getString("body");
        JSObject headers = call.getObject("headers", new JSObject());
        String token = readLocalAgentToken();

        new Thread(() -> {
            try {
                JSObject result = forwardLocalRequest(path, method, headers, body, timeoutMs, token);
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Local agent request failed");
            }
        }, "eliza-agent-request").start();
    }

    private static JSObject status(String state, String error) {
        JSObject result = new JSObject();
        result.put("state", state);
        result.put("agentName", JSONObject.NULL);
        result.put("port", "not_started".equals(state) ? JSONObject.NULL : 31337);
        result.put("startedAt", JSONObject.NULL);
        result.put("error", error != null ? error : JSONObject.NULL);
        return result;
    }

    private static String readLocalAgentToken() {
        String token = ElizaAgentService.localAgentToken();
        if (token == null) return null;
        String trimmed = token.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static JSObject forwardLocalRequest(
        String path,
        String method,
        JSObject headers,
        String body,
        int timeoutMs,
        String token
    ) throws Exception {
        byte[] requestBody = body != null ? body.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;
        if (requestBody != null && requestBody.length > MAX_REQUEST_BODY_BYTES) {
            throw new IllegalArgumentException("Request body is too large");
        }

        HttpURLConnection connection = (HttpURLConnection) new URL(LOCAL_AGENT_BASE_URL + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(timeoutMs);
        connection.setReadTimeout(timeoutMs);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);

        applyHeaders(connection, headers);
        if (token != null && trimToNull(connection.getRequestProperty("Authorization")) == null) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }

        if (requestBody != null && !"GET".equals(method) && !"HEAD".equals(method)) {
            connection.setDoOutput(true);
            connection.getOutputStream().write(requestBody);
        }

        int status = connection.getResponseCode();
        String responseBody = readResponseBody(connection, status);
        JSObject responseHeaders = new JSObject();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            String key = entry.getKey();
            List<String> values = entry.getValue();
            if (key == null || values == null || values.isEmpty()) continue;
            responseHeaders.put(key.toLowerCase(Locale.US), String.join(", ", values));
        }

        JSObject result = new JSObject();
        result.put("status", status);
        result.put("statusText", connection.getResponseMessage() != null ? connection.getResponseMessage() : "");
        result.put("headers", responseHeaders);
        result.put("body", responseBody);
        return result;
    }

    private static void applyHeaders(HttpURLConnection connection, JSObject headers) {
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key == null || isBlockedHeader(key)) continue;
            Object value = headers.opt(key);
            if (!(value instanceof String)) continue;
            String trimmed = trimToNull((String) value);
            if (trimmed != null) {
                connection.setRequestProperty(key, trimmed);
            }
        }
    }

    private static String readResponseBody(HttpURLConnection connection, int status) throws Exception {
        InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            while (true) {
                int count = input.read(buffer);
                if (count == -1) break;
                total += count;
                if (total > MAX_RESPONSE_BODY_BYTES) {
                    throw new IllegalStateException("Response body is too large");
                }
                output.write(buffer, 0, count);
            }
            return output.toString(java.nio.charset.StandardCharsets.UTF_8.name());
        }
    }

    private static boolean isBlockedHeader(String key) {
        return "host".equalsIgnoreCase(key)
            || "connection".equalsIgnoreCase(key)
            || "content-length".equalsIgnoreCase(key);
    }

    private static int clampTimeout(Integer value) {
        int timeout = value != null ? value : DEFAULT_TIMEOUT_MS;
        return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeout));
    }

    private static boolean hasUrlScheme(String path) {
        return path.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*");
    }

    private static String trimToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
