/**
 * Pure-JVM decoder for the native-transcript contract
 * (eliza.native-transcript/v1, defined in
 * packages/ui/src/chat/native-transcript/spec.ts). Turns the frame JSON the
 * NativeTranscript Capacitor plugin receives into typed models the Android
 * renderer draws. Deliberately imports ONLY org.json + java.util — no android
 * classes — so the golden-fixture conformance test
 * (src/test/java/ai/elizaos/app/transcript/TranscriptContractTest.java) runs
 * on a plain JVM with no Robolectric.
 *
 * Decode policy is tolerant-additive, matching the v1 contract: an unknown
 * segment kind becomes an {@link UnknownSegment} (the renderer's fallback
 * row), an unknown widget kind keeps its raw data for the same fallback, and
 * missing optional fields default to empty — but a segment/widget the fixture
 * guarantees (text, code, the seven widget kinds, permission, ui-spec,
 * config) always decodes to its typed model, and the conformance test pins
 * that with a kind histogram over the committed golden fixture.
 */
package ai.elizaos.app.transcript;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

public final class TranscriptModels {

    public static final String SCHEMA = "eliza.native-transcript/v1";

    private TranscriptModels() {}

    // ── Frame ───────────────────────────────────────────────────────────

    public static final class Frame {
        public final String schema;
        public final List<Message> messages;
        /** Nullable — absent when the host sent no turn status. */
        public final TurnStatus turnStatus;

        Frame(String schema, List<Message> messages, TurnStatus turnStatus) {
            this.schema = schema;
            this.messages = Collections.unmodifiableList(messages);
            this.turnStatus = turnStatus;
        }
    }

    public static final class TurnStatus {
        public final String kind;
        /** Nullable. */
        public final String label;

        TurnStatus(String kind, String label) {
            this.kind = kind;
            this.label = label;
        }
    }

    public static final class Message {
        public final String id;
        /** "user" or "assistant" (unknown roles normalize to assistant). */
        public final String role;
        public final List<Segment> segments;
        /** Nullable side channels, mirroring NativeTranscriptMessage. */
        public final String reasoning;
        public final List<ToolEvent> toolEvents;
        public final String failureKind;
        public final SecretRequest secretRequest;
        public final boolean streaming;
        /**
         * Raw message JSON, used as the renderer's rebuild fingerprint: a row
         * whose fingerprint is unchanged keeps its live view (and therefore
         * its in-progress form/choice/disclosure state) across full-frame
         * replaces.
         */
        public final String fingerprint;

        Message(String id, String role, List<Segment> segments,
                String reasoning, List<ToolEvent> toolEvents,
                String failureKind, SecretRequest secretRequest,
                boolean streaming, String fingerprint) {
            this.id = id;
            this.role = role;
            this.segments = Collections.unmodifiableList(segments);
            this.reasoning = reasoning;
            this.toolEvents = Collections.unmodifiableList(toolEvents);
            this.failureKind = failureKind;
            this.secretRequest = secretRequest;
            this.streaming = streaming;
            this.fingerprint = fingerprint;
        }

        public boolean isUser() {
            return "user".equals(role);
        }
    }

    // ── Segments ────────────────────────────────────────────────────────

    public abstract static class Segment {
        public final String kind;

        Segment(String kind) {
            this.kind = kind;
        }
    }

    public static final class TextSegment extends Segment {
        public final String text;

        TextSegment(String text) {
            super("text");
            this.text = text;
        }
    }

    public static final class CodeSegment extends Segment {
        public final String code;
        /** Nullable. */
        public final String lang;
        public final boolean inline;

        CodeSegment(String code, String lang, boolean inline) {
            super("code");
            this.code = code;
            this.lang = lang;
            this.inline = inline;
        }
    }

    public static final class PermissionSegment extends Segment {
        public final String permission;
        public final String reason;
        public final String feature;
        public final boolean fallbackOffered;

        PermissionSegment(String permission, String reason, String feature,
                boolean fallbackOffered) {
            super("permission");
            this.permission = permission;
            this.reason = reason;
            this.feature = feature;
            this.fallbackOffered = fallbackOffered;
        }
    }

    public static final class UiSpecSegment extends Segment {
        public final String raw;

        UiSpecSegment(String raw) {
            super("ui-spec");
            this.raw = raw;
        }
    }

    public static final class ConfigSegment extends Segment {
        public final String pluginId;

        ConfigSegment(String pluginId) {
            super("config");
            this.pluginId = pluginId;
        }
    }

    /** Fallback row for segment kinds this build does not know. */
    public static final class UnknownSegment extends Segment {
        public final String raw;

        UnknownSegment(String kind, String raw) {
            super(kind);
            this.raw = raw;
        }
    }

    // ── Widget segment + typed widget payloads ──────────────────────────

    public static final class WidgetSegment extends Segment {
        public final String widgetKind;
        /**
         * Exactly one of the typed payloads below is non-null for a known
         * widget kind; all are null for an unknown kind (fallback row shows
         * {@link #rawData}).
         */
        public final ChoiceData choice;
        public final FollowupsData followups;
        public final FormData form;
        public final WorkflowData workflow;
        public final ChecklistData checklist;
        public final TaskData task;
        public final BackgroundData background;
        public final String rawData;

        WidgetSegment(String widgetKind, ChoiceData choice,
                FollowupsData followups, FormData form, WorkflowData workflow,
                ChecklistData checklist, TaskData task,
                BackgroundData background, String rawData) {
            super("widget");
            this.widgetKind = widgetKind;
            this.choice = choice;
            this.followups = followups;
            this.form = form;
            this.workflow = workflow;
            this.checklist = checklist;
            this.task = task;
            this.background = background;
            this.rawData = rawData;
        }

        public boolean hasTypedPayload() {
            return choice != null || followups != null || form != null
                    || workflow != null || checklist != null || task != null
                    || background != null;
        }
    }

    public static final class ChoiceOption {
        public final String value;
        public final String label;

        ChoiceOption(String value, String label) {
            this.value = value;
            this.label = label;
        }
    }

    public static final class ChoiceData {
        public final String id;
        public final String scope;
        public final boolean allowCustom;
        public final List<ChoiceOption> options;

        ChoiceData(String id, String scope, boolean allowCustom,
                List<ChoiceOption> options) {
            this.id = id;
            this.scope = scope;
            this.allowCustom = allowCustom;
            this.options = Collections.unmodifiableList(options);
        }

        public boolean isFirstRun() {
            return scope != null && scope.startsWith("first-run");
        }
    }

    public static final class FollowupOption {
        /** "reply" | "prompt" | "navigate" (unknown kinds act as reply). */
        public final String kind;
        public final String payload;
        public final String label;

        FollowupOption(String kind, String payload, String label) {
            this.kind = kind;
            this.payload = payload;
            this.label = label;
        }
    }

    public static final class FollowupsData {
        public final String id;
        public final List<FollowupOption> options;

        FollowupsData(String id, List<FollowupOption> options) {
            this.id = id;
            this.options = Collections.unmodifiableList(options);
        }
    }

    public static final class FormField {
        public final String name;
        /** text | number | date | time | datetime | select | checkbox. */
        public final String type;
        public final String label;
        public final boolean required;
        /** Nullable. */
        public final String placeholder;
        public final List<ChoiceOption> options;

        FormField(String name, String type, String label, boolean required,
                String placeholder, List<ChoiceOption> options) {
            this.name = name;
            this.type = type;
            this.label = label;
            this.required = required;
            this.placeholder = placeholder;
            this.options = Collections.unmodifiableList(options);
        }
    }

    public static final class FormData {
        public final String id;
        public final String title;
        public final String description;
        public final String submitLabel;
        public final List<FormField> fields;

        FormData(String id, String title, String description,
                String submitLabel, List<FormField> fields) {
            this.id = id;
            this.title = title;
            this.description = description;
            this.submitLabel = submitLabel;
            this.fields = Collections.unmodifiableList(fields);
        }
    }

    public static final class WorkflowStep {
        public final String label;
        /** pending | running | done | failed. */
        public final String status;

        WorkflowStep(String label, String status) {
            this.label = label;
            this.status = status;
        }
    }

    public static final class WorkflowData {
        public final String id;
        public final String title;
        public final List<WorkflowStep> steps;

        WorkflowData(String id, String title, List<WorkflowStep> steps) {
            this.id = id;
            this.title = title;
            this.steps = Collections.unmodifiableList(steps);
        }
    }

    public static final class ChecklistItem {
        public final String content;
        /** pending | in_progress | completed. */
        public final String status;

        ChecklistItem(String content, String status) {
            this.content = content;
            this.status = status;
        }
    }

    public static final class ChecklistData {
        public final String title;
        public final List<ChecklistItem> items;

        ChecklistData(String title, List<ChecklistItem> items) {
            this.title = title;
            this.items = Collections.unmodifiableList(items);
        }
    }

    public static final class TaskData {
        public final String threadId;
        public final String title;

        TaskData(String threadId, String title) {
            this.threadId = threadId;
            this.title = title;
        }
    }

    /** The `[BACKGROUND]` marker carries no payload — presence is the data. */
    public static final class BackgroundData {
        BackgroundData() {}
    }

    // ── Side channels ───────────────────────────────────────────────────

    public static final class ToolEvent {
        public final String id;
        /** tool_call | tool_result | tool_error. */
        public final String type;
        public final String actionName;
        /** Nullable pretty-printed JSON for the expanded disclosure. */
        public final String argsJson;
        public final String resultJson;
        /** running | completed | error (absent normalizes per type). */
        public final String status;
        /** Negative when the event carried no duration. */
        public final long durationMs;
        public final String error;

        ToolEvent(String id, String type, String actionName, String argsJson,
                String resultJson, String status, long durationMs,
                String error) {
            this.id = id;
            this.type = type;
            this.actionName = actionName;
            this.argsJson = argsJson;
            this.resultJson = resultJson;
            this.status = status;
            this.durationMs = durationMs;
            this.error = error;
        }
    }

    public static final class SecretField {
        public final String name;
        public final String label;
        /** secret | text (uploads are not collectable in this renderer). */
        public final String input;
        public final boolean required;

        SecretField(String name, String label, String input,
                boolean required) {
            this.name = name;
            this.label = label;
            this.input = input;
            this.required = required;
        }
    }

    public static final class SecretRequest {
        public final String key;
        public final String reason;
        /** pending | saved | failed | …. */
        public final String status;
        public final String submitLabel;
        /** secret | oauth | remote_connect (only `secret` collects here). */
        public final String formKind;
        /** True only when delivery sanctions in-channel collection. */
        public final boolean canCollectInChannel;
        public final List<SecretField> fields;

        SecretRequest(String key, String reason, String status,
                String submitLabel, String formKind,
                boolean canCollectInChannel, List<SecretField> fields) {
            this.key = key;
            this.reason = reason;
            this.status = status;
            this.submitLabel = submitLabel;
            this.formKind = formKind;
            this.canCollectInChannel = canCollectInChannel;
            this.fields = Collections.unmodifiableList(fields);
        }
    }

    // ── Decode ──────────────────────────────────────────────────────────

    public static Frame decodeFrame(JSONObject json) {
        String schema = json.optString("schema", "");
        List<Message> messages = new ArrayList<>();
        JSONArray rawMessages = json.optJSONArray("messages");
        if (rawMessages != null) {
            for (int i = 0; i < rawMessages.length(); i++) {
                JSONObject rawMessage = rawMessages.optJSONObject(i);
                if (rawMessage != null) {
                    messages.add(decodeMessage(rawMessage));
                }
            }
        }
        TurnStatus turnStatus = null;
        JSONObject rawStatus = json.optJSONObject("turnStatus");
        if (rawStatus != null) {
            turnStatus = new TurnStatus(
                    rawStatus.optString("kind", ""),
                    optNullableString(rawStatus, "label"));
        }
        return new Frame(schema, messages, turnStatus);
    }

    public static Message decodeMessage(JSONObject json) {
        String role = "user".equals(json.optString("role"))
                ? "user" : "assistant";
        List<Segment> segments = new ArrayList<>();
        JSONArray rawSegments = json.optJSONArray("segments");
        if (rawSegments != null) {
            for (int i = 0; i < rawSegments.length(); i++) {
                JSONObject rawSegment = rawSegments.optJSONObject(i);
                if (rawSegment != null) {
                    segments.add(decodeSegment(rawSegment));
                }
            }
        }
        List<ToolEvent> toolEvents = new ArrayList<>();
        JSONArray rawEvents = json.optJSONArray("toolEvents");
        if (rawEvents != null) {
            for (int i = 0; i < rawEvents.length(); i++) {
                JSONObject rawEvent = rawEvents.optJSONObject(i);
                if (rawEvent != null) {
                    toolEvents.add(decodeToolEvent(rawEvent));
                }
            }
        }
        SecretRequest secretRequest = null;
        JSONObject rawSecret = json.optJSONObject("secretRequest");
        if (rawSecret != null) {
            secretRequest = decodeSecretRequest(rawSecret);
        }
        return new Message(
                json.optString("id", ""),
                role,
                segments,
                optNullableString(json, "reasoning"),
                toolEvents,
                optNullableString(json, "failureKind"),
                secretRequest,
                json.optBoolean("streaming", false),
                json.toString());
    }

    public static Segment decodeSegment(JSONObject json) {
        String kind = json.optString("kind", "");
        switch (kind) {
            case "text":
                return new TextSegment(json.optString("text", ""));
            case "code":
                return new CodeSegment(
                        json.optString("code", ""),
                        optNullableString(json, "lang"),
                        json.optBoolean("inline", false));
            case "widget":
                return decodeWidget(
                        json.optString("widgetKind", ""),
                        json.optJSONObject("data"));
            case "permission": {
                JSONObject payload = json.optJSONObject("payload");
                if (payload == null) payload = new JSONObject();
                return new PermissionSegment(
                        payload.optString("permission", ""),
                        payload.optString("reason", ""),
                        payload.optString("feature", ""),
                        payload.optBoolean("fallbackOffered",
                                payload.optBoolean("fallback_offered",
                                        false)));
            }
            case "ui-spec":
                return new UiSpecSegment(json.optString("raw", ""));
            case "config":
                return new ConfigSegment(json.optString("pluginId", ""));
            default:
                return new UnknownSegment(kind, json.toString());
        }
    }

    private static WidgetSegment decodeWidget(String widgetKind,
            JSONObject data) {
        if (data == null) data = new JSONObject();
        String rawData = data.toString();
        switch (widgetKind) {
            case "choice":
                return new WidgetSegment(widgetKind, decodeChoice(data), null,
                        null, null, null, null, null, rawData);
            case "followups":
                return new WidgetSegment(widgetKind, null,
                        decodeFollowups(data), null, null, null, null, null,
                        rawData);
            case "form":
                return new WidgetSegment(widgetKind, null, null,
                        decodeForm(data.optJSONObject("form")), null, null,
                        null, null, rawData);
            case "workflow":
                return new WidgetSegment(widgetKind, null, null, null,
                        decodeWorkflow(data.optJSONObject("workflow")), null,
                        null, null, rawData);
            case "checklist":
                return new WidgetSegment(widgetKind, null, null, null, null,
                        decodeChecklist(data.optJSONObject("checklist")), null,
                        null, rawData);
            case "task":
                return new WidgetSegment(widgetKind, null, null, null, null,
                        null,
                        new TaskData(data.optString("threadId", ""),
                                data.optString("title", "")),
                        null, rawData);
            case "background":
                return new WidgetSegment(widgetKind, null, null, null, null,
                        null, null, new BackgroundData(), rawData);
            default:
                return new WidgetSegment(widgetKind, null, null, null, null,
                        null, null, null, rawData);
        }
    }

    private static ChoiceData decodeChoice(JSONObject data) {
        List<ChoiceOption> options = new ArrayList<>();
        JSONArray rawOptions = data.optJSONArray("options");
        if (rawOptions != null) {
            for (int i = 0; i < rawOptions.length(); i++) {
                JSONObject rawOption = rawOptions.optJSONObject(i);
                if (rawOption == null) continue;
                String value = rawOption.optString("value", "");
                options.add(new ChoiceOption(value,
                        rawOption.optString("label", value)));
            }
        }
        return new ChoiceData(
                data.optString("id", ""),
                data.optString("scope", ""),
                data.optBoolean("allowCustom", false),
                options);
    }

    private static FollowupsData decodeFollowups(JSONObject data) {
        List<FollowupOption> options = new ArrayList<>();
        JSONArray rawOptions = data.optJSONArray("options");
        if (rawOptions != null) {
            for (int i = 0; i < rawOptions.length(); i++) {
                JSONObject rawOption = rawOptions.optJSONObject(i);
                if (rawOption == null) continue;
                String payload = rawOption.optString("payload", "");
                options.add(new FollowupOption(
                        rawOption.optString("kind", "reply"),
                        payload,
                        rawOption.optString("label", payload)));
            }
        }
        return new FollowupsData(data.optString("id", ""), options);
    }

    private static FormData decodeForm(JSONObject form) {
        if (form == null) form = new JSONObject();
        List<FormField> fields = new ArrayList<>();
        JSONArray rawFields = form.optJSONArray("fields");
        if (rawFields != null) {
            for (int i = 0; i < rawFields.length(); i++) {
                JSONObject rawField = rawFields.optJSONObject(i);
                if (rawField == null) continue;
                String name = rawField.optString("name", "");
                List<ChoiceOption> options = new ArrayList<>();
                JSONArray rawOptions = rawField.optJSONArray("options");
                if (rawOptions != null) {
                    for (int j = 0; j < rawOptions.length(); j++) {
                        JSONObject rawOption = rawOptions.optJSONObject(j);
                        if (rawOption == null) continue;
                        String value = rawOption.optString("value", "");
                        options.add(new ChoiceOption(value,
                                rawOption.optString("label", value)));
                    }
                }
                fields.add(new FormField(
                        name,
                        rawField.optString("type", "text"),
                        rawField.optString("label", name),
                        rawField.optBoolean("required", false),
                        optNullableString(rawField, "placeholder"),
                        options));
            }
        }
        return new FormData(
                form.optString("id", ""),
                optNullableString(form, "title"),
                optNullableString(form, "description"),
                form.optString("submitLabel", "Submit"),
                fields);
    }

    private static WorkflowData decodeWorkflow(JSONObject workflow) {
        if (workflow == null) workflow = new JSONObject();
        List<WorkflowStep> steps = new ArrayList<>();
        JSONArray rawSteps = workflow.optJSONArray("steps");
        if (rawSteps != null) {
            for (int i = 0; i < rawSteps.length(); i++) {
                JSONObject rawStep = rawSteps.optJSONObject(i);
                if (rawStep == null) continue;
                steps.add(new WorkflowStep(
                        rawStep.optString("label", ""),
                        rawStep.optString("status", "pending")));
            }
        }
        return new WorkflowData(
                workflow.optString("id", ""),
                optNullableString(workflow, "title"),
                steps);
    }

    private static ChecklistData decodeChecklist(JSONObject checklist) {
        if (checklist == null) checklist = new JSONObject();
        List<ChecklistItem> items = new ArrayList<>();
        JSONArray rawItems = checklist.optJSONArray("items");
        if (rawItems != null) {
            for (int i = 0; i < rawItems.length(); i++) {
                JSONObject rawItem = rawItems.optJSONObject(i);
                if (rawItem == null) continue;
                items.add(new ChecklistItem(
                        rawItem.optString("content", ""),
                        rawItem.optString("status", "pending")));
            }
        }
        return new ChecklistData(
                optNullableString(checklist, "title"), items);
    }

    private static ToolEvent decodeToolEvent(JSONObject json) {
        String actionName = json.optString("actionName",
                json.optString("toolName", json.optString("name", "")));
        String status = optNullableString(json, "status");
        if (status == null) {
            // The DOM log derives an implicit status from the event type when
            // none is carried; mirror that so rows never render status-less.
            status = "tool_error".equals(json.optString("type"))
                    ? "error"
                    : "tool_result".equals(json.optString("type"))
                            ? "completed" : "running";
        }
        JSONObject args = json.optJSONObject("args");
        if (args == null) args = json.optJSONObject("input");
        Object result = json.opt("result");
        if (result == null) result = json.opt("output");
        return new ToolEvent(
                json.optString("id", ""),
                json.optString("type", "tool_call"),
                actionName,
                args != null ? prettyJson(args) : null,
                result != null ? prettyValue(result) : null,
                status,
                json.has("durationMs") ? json.optLong("durationMs", -1L)
                        : json.optLong("duration", -1L),
                optNullableString(json, "error"));
    }

    private static SecretRequest decodeSecretRequest(JSONObject json) {
        JSONObject form = json.optJSONObject("form");
        List<SecretField> fields = new ArrayList<>();
        String submitLabel = "Save";
        String formKind = "";
        if (form != null) {
            formKind = form.optString("kind", "");
            submitLabel = form.optString("submitLabel", "Save");
            JSONArray rawFields = form.optJSONArray("fields");
            if (rawFields != null) {
                for (int i = 0; i < rawFields.length(); i++) {
                    JSONObject rawField = rawFields.optJSONObject(i);
                    if (rawField == null) continue;
                    String name = rawField.optString("name", "");
                    fields.add(new SecretField(
                            name,
                            rawField.optString("label", name),
                            rawField.optString("input", "text"),
                            rawField.optBoolean("required", false)));
                }
            }
        }
        JSONObject delivery = json.optJSONObject("delivery");
        boolean canCollect = delivery != null
                && delivery.optBoolean("canCollectValueInCurrentChannel",
                        false);
        return new SecretRequest(
                json.optString("key", ""),
                optNullableString(json, "reason"),
                json.optString("status", "pending"),
                submitLabel,
                formKind,
                canCollect,
                fields);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static String optNullableString(JSONObject json, String key) {
        if (!json.has(key) || json.isNull(key)) return null;
        String value = json.optString(key, "");
        return value.isEmpty() ? null : value;
    }

    private static String prettyJson(JSONObject json) {
        try {
            return json.toString(2);
        } catch (org.json.JSONException e) {
            return json.toString();
        }
    }

    private static String prettyValue(Object value) {
        if (value instanceof JSONObject) return prettyJson((JSONObject) value);
        if (value instanceof JSONArray) {
            try {
                return ((JSONArray) value).toString(2);
            } catch (org.json.JSONException e) {
                return value.toString();
            }
        }
        return String.valueOf(value);
    }
}
