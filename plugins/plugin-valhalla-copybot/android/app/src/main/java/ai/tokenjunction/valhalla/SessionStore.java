package ai.tokenjunction.valhalla;

import android.content.Context;
import android.content.SharedPreferences;

/** Private phone state. This store never accepts a wallet key. */
final class SessionStore {
    static final String SCREEN_PAIRING = "pairing";
    static final String SCREEN_STATUS = "status";
    static final String SCREEN_CHAT = "chat";
    static final String SCREEN_ERRORS = "errors";

    private final SharedPreferences prefs;

    SessionStore(Context context) {
        prefs = context.getSharedPreferences("valhalla-phone", Context.MODE_PRIVATE);
    }

    String deskUrl() {
        return prefs.getString("desk_url", "");
    }

    String accessCode() {
        return prefs.getString("access_code", "");
    }

    String token() {
        return prefs.getString("pair_token", "");
    }

    String lastScreen() {
        return prefs.getString("last_screen", SCREEN_PAIRING);
    }

    String cachedState() {
        return prefs.getString("cached_state", "");
    }

    String chatLog() {
        return prefs.getString("chat_log", "");
    }

    String suggestion() {
        return prefs.getString("suggestion", "");
    }

    void saveDesk(String url, String accessCode) {
        prefs.edit().putString("desk_url", url).putString("access_code", accessCode).apply();
    }

    void saveToken(String token) {
        prefs.edit().putString("pair_token", token).apply();
    }

    void clearToken() {
        prefs.edit().remove("pair_token").apply();
    }

    void saveScreen(String screen) {
        prefs.edit().putString("last_screen", screen).apply();
    }

    void saveState(String json) {
        String value = json == null ? "" : json;
        if (value.length() > 20_000) value = value.substring(0, 20_000);
        prefs.edit().putString("cached_state", value).apply();
    }

    void saveChat(String text) {
        String value = text == null ? "" : text;
        if (value.length() > 12_000) value = value.substring(value.length() - 12_000);
        prefs.edit().putString("chat_log", value).apply();
    }

    void saveSuggestion(String json) {
        prefs.edit().putString("suggestion", json == null ? "" : json).apply();
    }
}
