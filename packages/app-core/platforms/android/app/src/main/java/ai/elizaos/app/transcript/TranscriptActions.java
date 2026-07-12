/**
 * Action-string formatters for the native transcript's return channel. Every
 * widget interaction on the Android renderer is emitted as a plain string on
 * the plugin's single "transcriptAction" event, and these formatters produce
 * byte-identical strings to what the DOM widgets pass to `sendActionMessage`
 * — the protocol documented at the bottom of
 * packages/ui/src/chat/native-transcript/spec.ts. The app-side handler must
 * never be able to tell which renderer produced an action, so there is no
 * Android-only format here: strings the DOM never sends (background pick,
 * secret value) ride the same channel as free-typed composer text, which the
 * contract explicitly passes through unchanged.
 *
 * Pure JVM (org.json + java.util only) so the golden-fixture contract test
 * asserts these formats without Robolectric.
 */
package ai.elizaos.app.transcript;

import java.util.Map;

import org.json.JSONObject;

public final class TranscriptActions {

    private TranscriptActions() {}

    /** A choice tap sends the option's value verbatim (`__first_run__:…`). */
    public static String choice(String optionValue) {
        return optionValue;
    }

    /**
     * A followup tap sends the option's payload verbatim. On the DOM,
     * `prompt` chips prefill the composer and `navigate` chips dispatch a
     * local view event; the native list has neither surface, so both take
     * the DOM's own documented fallback (send the payload as a message) and
     * the agent-side planner handles it.
     */
    public static String followup(String payload) {
        return payload;
    }

    /**
     * Form submit: `[form:submit <formId>] {json}` — the exact string
     * `useInlineWidgetContext.submitForm` builds. Values are strings for
     * text/number/date/select fields and booleans for checkboxes.
     */
    public static String formSubmit(String formId, Map<String, Object> values) {
        return "[form:submit " + formId + "] "
                + new JSONObject(values).toString();
    }

    /** Permission card "use fallback" — MessagePermissionCard parity. */
    public static String permissionFallback(String feature,
            String permission) {
        return "__permission_card__:use_fallback feature=" + feature
                + " permission=" + permission;
    }


    /**
     * Config-segment tap: the exact request string the DOM's `plugin:configure`
     * UiSpec action sends, so the agent replies with the plugin's config form.
     */
    public static String openPluginConfig(String pluginId) {
        return "Please show me the configuration form for the " + pluginId
                + " plugin";
    }
}
