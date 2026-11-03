package ai.tokenjunction.valhalla;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Talks to the paired PC agent. It never sends a wallet key. */
final class DeskClient {
    static final class Result {
        boolean ok;
        boolean tokenExpired;
        boolean stalled;
        boolean offline;
        String message = "";
        String state = "";
        String suggestion = "";
        int code;
    }

    private final SessionStore store;
    private final ErrorLog errors;

    DeskClient(SessionStore store, ErrorLog errors) {
        this.store = store;
        this.errors = errors;
    }

    Result pair() {
        JSONObject body = new JSONObject();
        try {
            body.put("accessCode", store.accessCode());
        } catch (Exception ignored) {
            // The code is optional.
        }
        Result result = call("POST", "/api/companion/pair", body, false);
        if (result.ok) {
            try {
                JSONObject json = new JSONObject(result.message);
                store.saveToken(json.optString("token", ""));
                result.message = "Paired with the PC agent.";
            } catch (Exception err) {
                result.ok = false;
                result.message = "The desk answer could not be read.";
                errors.add(result.message);
            }
        }
        return result;
    }

    Result heartbeat() {
        Result result = call("GET", "/api/companion/heartbeat", null, true);
        if (result.tokenExpired && repair()) result = call("GET", "/api/companion/heartbeat", null, true);
        if (result.ok) fillState(result);
        return result;
    }

    Result recover() {
        Result result = call("POST", "/api/companion/recover", new JSONObject(), true);
        if (result.tokenExpired && repair()) result = call("POST", "/api/companion/recover", new JSONObject(), true);
        if (result.ok) fillMessage(result);
        return result;
    }

    Result chat(String text) {
        JSONObject body = new JSONObject();
        try {
            body.put("text", text);
        } catch (Exception ignored) {
            // Text is plain.
        }
        Result result = call("POST", "/api/companion/chat", body, true);
        if (result.tokenExpired && repair()) result = call("POST", "/api/companion/chat", body, true);
        if (!result.ok) return result;
        try {
            JSONObject json = new JSONObject(result.message);
            result.message = json.optString("message", "");
            if (json.isNull("suggestion")) result.suggestion = "";
            else result.suggestion = json.optJSONObject("suggestion") == null ? "" : json.getJSONObject("suggestion").toString();
            if (json.has("suggestionError")) errors.add(json.optString("suggestionError"));
        } catch (Exception err) {
            result.ok = false;
            result.message = "The chat answer could not be read.";
            errors.add(result.message);
        }
        return result;
    }

    Result confirm(String suggestionJson) {
        JSONObject body = new JSONObject();
        try {
            body.put("confirm", true);
            body.put("settings", new JSONObject(suggestionJson));
        } catch (Exception err) {
            Result bad = new Result();
            bad.message = "That suggestion could not be read.";
            errors.add(bad.message);
            return bad;
        }
        Result result = call("POST", "/api/companion/settings", body, true);
        if (result.tokenExpired && repair()) result = call("POST", "/api/companion/settings", body, true);
        if (result.ok) fillMessage(result);
        return result;
    }

    private boolean repair() {
        errors.add("Pairing token expired. Requesting a new one.");
        Result again = pair();
        if (!again.ok) {
            store.clearToken();
            errors.add(again.message);
        }
        return again.ok;
    }

    private void fillState(Result result) {
        try {
            JSONObject json = new JSONObject(result.message);
            result.stalled = json.optBoolean("stalled", false);
            JSONObject state = json.optJSONObject("state");
            result.state = state == null ? "" : state.toString();
            result.message = state == null ? "" : state.optString("status", "Desk answered.");
            if (!result.state.isEmpty()) store.saveState(result.state);
        } catch (Exception err) {
            result.ok = false;
            result.offline = true;
            result.message = "The heartbeat could not be read.";
            errors.add(result.message);
        }
    }

    private void fillMessage(Result result) {
        try {
            JSONObject json = new JSONObject(result.message);
            result.message = json.optString("message", json.optString("error", "Done."));
            if (!json.optBoolean("ok", true) && result.code >= 400) result.ok = false;
        } catch (Exception err) {
            result.message = "The desk answer could not be read.";
            errors.add(result.message);
        }
    }

    private Result call(String method, String path, JSONObject body, boolean auth) {
        Result result = new Result();
        String base = store.deskUrl();
        if (base == null || !(base.startsWith("http://") || base.startsWith("https://"))) {
            result.offline = true;
            result.message = "Enter the PC desk address first.";
            return result;
        }
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + path).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod(method);
            if (auth && store.token() != null && !store.token().isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + store.token());
            }
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(bytes);
                }
            }
            result.code = conn.getResponseCode();
            InputStream stream = result.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            result.message = read(stream);
            result.ok = result.code >= 200 && result.code < 300;
            if (result.code == 401 && result.message.contains("tokenExpired")) {
                result.tokenExpired = new JSONObject(result.message).optBoolean("tokenExpired", false);
                if (result.tokenExpired) result.message = "Pair again.";
            }
            if (!result.ok && !result.tokenExpired) {
                result.offline = result.code == 0;
                String error = "Desk returned " + result.code;
                try {
                    error = new JSONObject(result.message).optString("error", error);
                } catch (Exception ignored) {
                    // Keep the status code.
                }
                result.message = error;
                errors.add(path + " " + error);
            }
        } catch (Exception err) {
            result.offline = true;
            result.message = "The PC agent did not answer.";
            errors.add(result.message);
        } finally {
            if (conn != null) conn.disconnect();
        }
        return result;
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[2048];
        int n;
        while ((n = stream.read(buf)) >= 0) {
            out.write(buf, 0, n);
            if (out.size() > 40_000) break;
        }
        stream.close();
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
