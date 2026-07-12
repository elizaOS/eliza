/**
 * Widget renderers for the native transcript: choice, followups, form,
 * workflow, checklist, task, background, permission card, and the secret
 * masked field — the same interaction matrix the DOM widgets ship, drawn with
 * framework Views and wired to the SAME action strings (see
 * TranscriptActions; protocol reference: packages/ui/src/chat/
 * native-transcript/spec.ts). Behavioral parity notes:
 *
 *  - choice/followups lock after one reply so the agent only ever sees one
 *    decision per prompt (ChoiceWidget/FollowupsWidget parity);
 *  - `prompt`/`navigate` followups have no composer/nav surface here, so both
 *    send their payload as a message — the DOM prompt chip's own documented
 *    fallback;
 *  - the form enforces required-field validation before submitting
 *    `[form:submit <id>] {json}`;
 *  - the secret card renders ONLY when delivery sanctions in-channel
 *    collection, masks input, and submits the raw value the same way a user
 *    typing the key into the composer would;
 *  - workflow/checklist/task rows are display-only, like their DOM
 *    counterparts inside this transcript surface.
 *
 * Views hold their own interaction state (selection, drafts, submitted), so
 * TranscriptView must keep a row's view instance alive across frame replaces
 * whenever the message fingerprint is unchanged.
 */
package ai.elizaos.app.transcript;

import android.content.Context;
import android.graphics.Typeface;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.TextView;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

public final class TranscriptWidgets {

    /** Sink for every widget interaction — one channel, plain strings. */
    public interface ActionSink {
        void send(String message);
    }

    private TranscriptWidgets() {}

    private static int dp(Context c, float v) {
        return TranscriptUi.dp(c, v);
    }

    // ── Choice ──────────────────────────────────────────────────────────

    public static View choice(Context context,
            TranscriptModels.ChoiceData data, ActionSink sink) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        boolean firstRun = data.isFirstRun();
        final boolean[] locked = {false};

        LinearLayout host;
        if (firstRun) {
            host = column;
        } else {
            // Mid-conversation choices are a wrapping chip row.
            host = new LinearLayout(context);
            host.setOrientation(LinearLayout.HORIZONTAL);
            HorizontalScrollView scroller = new HorizontalScrollView(context);
            scroller.setHorizontalScrollBarEnabled(false);
            scroller.addView(host);
            column.addView(scroller, TranscriptUi.fillParams());
        }

        for (TranscriptModels.ChoiceOption option : data.options) {
            TextView button = firstRun
                    ? TranscriptUi.surfaceRow(context, option.label + "  ›")
                    : TranscriptUi.chip(context, option.label);
            LinearLayout.LayoutParams params = firstRun
                    ? TranscriptUi.fillParams() : TranscriptUi.wrapParams();
            if (firstRun) {
                params.topMargin = dp(context, 6);
            } else {
                params.rightMargin = dp(context, 8);
            }
            button.setOnClickListener(v -> {
                if (locked[0]) return;
                locked[0] = true;
                lockRow(host, button);
                if (firstRun) {
                    button.setText("✓ " + option.label);
                } else {
                    TranscriptUi.markChipSelected(context, button);
                }
                sink.send(TranscriptActions.choice(option.value));
            });
            host.addView(button, params);
        }

        if (data.allowCustom) {
            // "Other…" opens a one-line free answer that rides the same
            // channel (ChoiceWidget custom-answer parity).
            LinearLayout customRow = new LinearLayout(context);
            customRow.setOrientation(LinearLayout.HORIZONTAL);
            customRow.setGravity(Gravity.CENTER_VERTICAL);
            EditText input = field(context, "Type your answer…", false);
            input.setVisibility(View.GONE);
            TextView open = TranscriptUi.chip(context, "Other…");
            TextView send = TranscriptUi.chip(context, "Send");
            send.setVisibility(View.GONE);
            open.setOnClickListener(v -> {
                if (locked[0]) return;
                open.setVisibility(View.GONE);
                input.setVisibility(View.VISIBLE);
                send.setVisibility(View.VISIBLE);
                input.requestFocus();
            });
            send.setOnClickListener(v -> {
                String value = input.getText().toString().trim();
                if (locked[0] || value.isEmpty()) return;
                locked[0] = true;
                lockRow(host, null);
                input.setEnabled(false);
                send.setAlpha(0.4f);
                sink.send(TranscriptActions.choice(value));
            });
            customRow.addView(open, TranscriptUi.wrapParams());
            LinearLayout.LayoutParams inputParams =
                    new LinearLayout.LayoutParams(0,
                            LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            inputParams.rightMargin = dp(context, 8);
            customRow.addView(input, inputParams);
            customRow.addView(send, TranscriptUi.wrapParams());
            LinearLayout.LayoutParams rowParams = TranscriptUi.fillParams();
            rowParams.topMargin = dp(context, 6);
            column.addView(customRow, rowParams);
        }
        return column;
    }

    // ── Followups ───────────────────────────────────────────────────────

    public static View followups(Context context,
            TranscriptModels.FollowupsData data, ActionSink sink) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        final boolean[] locked = {false};
        for (TranscriptModels.FollowupOption option : data.options) {
            String glyph = "navigate".equals(option.kind) ? "  →" : "";
            TextView chip = TranscriptUi.chip(context, option.label + glyph);
            chip.setOnClickListener(v -> {
                if (locked[0]) return;
                if ("reply".equals(option.kind)) {
                    // Only a reply locks the row (one decision per prompt);
                    // prompt/navigate chips stay re-tappable like the DOM.
                    locked[0] = true;
                    lockRow(row, chip);
                    TranscriptUi.markChipSelected(context, chip);
                }
                sink.send(TranscriptActions.followup(option.payload));
            });
            LinearLayout.LayoutParams params = TranscriptUi.wrapParams();
            params.rightMargin = dp(context, 8);
            row.addView(chip, params);
        }
        HorizontalScrollView scroller = new HorizontalScrollView(context);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.addView(row);
        return scroller;
    }

    // ── Form ────────────────────────────────────────────────────────────

    public static View form(Context context, TranscriptModels.FormData data,
            ActionSink sink) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);

        if (!TextUtils.isEmpty(data.title)) {
            column.addView(TranscriptUi.sectionLabel(context, data.title),
                    TranscriptUi.wrapParams());
        }
        if (!TextUtils.isEmpty(data.description)) {
            TextView description = TranscriptUi.text(context,
                    data.description, 12f, TranscriptUi.TEXT_MUTED);
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = dp(context, 4);
            column.addView(description, params);
        }

        Map<String, ValueReader> readers = new LinkedHashMap<>();
        Map<String, TextView> errorViews = new LinkedHashMap<>();

        for (TranscriptModels.FormField fieldSpec : data.fields) {
            LinearLayout.LayoutParams blockParams = TranscriptUi.fillParams();
            blockParams.topMargin = dp(context, 10);

            if ("checkbox".equals(fieldSpec.type)) {
                CheckBox checkbox = new CheckBox(context);
                checkbox.setText(fieldSpec.label);
                checkbox.setTextColor(TranscriptUi.TEXT_PRIMARY);
                checkbox.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
                checkbox.setButtonTintList(
                        android.content.res.ColorStateList.valueOf(
                                TranscriptUi.ACCENT));
                column.addView(checkbox, blockParams);
                readers.put(fieldSpec.name, checkbox::isChecked);
                continue;
            }

            TextView label = TranscriptUi.text(context, fieldSpec.label, 12f,
                    TranscriptUi.TEXT_PRIMARY);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            column.addView(label, blockParams);

            if ("select".equals(fieldSpec.type)) {
                TextView anchor = selectAnchor(context, fieldSpec, readers);
                LinearLayout.LayoutParams params = TranscriptUi.fillParams();
                params.topMargin = dp(context, 4);
                column.addView(anchor, params);
            } else {
                EditText input = field(context,
                        fieldSpec.placeholder != null ? fieldSpec.placeholder
                                : "",
                        false);
                if ("number".equals(fieldSpec.type)) {
                    input.setInputType(InputType.TYPE_CLASS_NUMBER
                            | InputType.TYPE_NUMBER_FLAG_DECIMAL
                            | InputType.TYPE_NUMBER_FLAG_SIGNED);
                }
                LinearLayout.LayoutParams params = TranscriptUi.fillParams();
                params.topMargin = dp(context, 4);
                column.addView(input, params);
                readers.put(fieldSpec.name,
                        () -> input.getText().toString().trim());
            }

            TextView error = TranscriptUi.text(context, "", 11f,
                    TranscriptUi.DANGER);
            error.setVisibility(View.GONE);
            LinearLayout.LayoutParams errorParams = TranscriptUi.fillParams();
            errorParams.topMargin = dp(context, 2);
            column.addView(error, errorParams);
            errorViews.put(fieldSpec.name, error);
        }

        TextView submit = TranscriptUi.primaryButton(context,
                data.submitLabel);
        LinearLayout.LayoutParams submitParams = TranscriptUi.wrapParams();
        submitParams.topMargin = dp(context, 12);
        final boolean[] submitted = {false};
        submit.setOnClickListener(v -> {
            if (submitted[0]) return;
            boolean valid = true;
            for (TranscriptModels.FormField fieldSpec : data.fields) {
                TextView error = errorViews.get(fieldSpec.name);
                if (error == null) continue;
                boolean missing = fieldSpec.required
                        && !"checkbox".equals(fieldSpec.type)
                        && isBlank(readers.get(fieldSpec.name));
                error.setText(missing
                        ? fieldSpec.label + " is required" : "");
                error.setVisibility(missing ? View.VISIBLE : View.GONE);
                valid &= !missing;
            }
            if (!valid) return;
            submitted[0] = true;
            Map<String, Object> values = new LinkedHashMap<>();
            for (Map.Entry<String, ValueReader> entry : readers.entrySet()) {
                values.put(entry.getKey(), entry.getValue().read());
            }
            submit.setText("Submitted");
            submit.setAlpha(0.5f);
            disableInputs(column);
            sink.send(TranscriptActions.formSubmit(data.id, values));
        });
        column.addView(submit, submitParams);
        return column;
    }

    // ── Workflow ────────────────────────────────────────────────────────

    public static View workflow(Context context,
            TranscriptModels.WorkflowData data) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        int done = 0;
        for (TranscriptModels.WorkflowStep step : data.steps) {
            if ("done".equals(step.status)) done++;
        }
        column.addView(headerRow(context,
                data.title != null ? data.title : "Workflow",
                done + "/" + data.steps.size()), TranscriptUi.fillParams());
        int index = 1;
        for (TranscriptModels.WorkflowStep step : data.steps) {
            String glyph;
            int tone;
            switch (step.status) {
                case "done":
                    glyph = "✓";
                    tone = TranscriptUi.OK;
                    break;
                case "running":
                    glyph = "◐";
                    tone = TranscriptUi.ACCENT;
                    break;
                case "failed":
                    glyph = "✕";
                    tone = TranscriptUi.DANGER;
                    break;
                default:
                    glyph = "○";
                    tone = TranscriptUi.TEXT_FAINT;
                    break;
            }
            int textTone = "done".equals(step.status)
                    ? TranscriptUi.TEXT_MUTED
                    : "failed".equals(step.status)
                            ? TranscriptUi.DANGER
                            : TranscriptUi.TEXT_PRIMARY;
            column.addView(statusLine(context, glyph, tone,
                    index + ".  " + step.label, textTone),
                    TranscriptUi.fillParams());
            index++;
        }
        return column;
    }

    // ── Checklist ───────────────────────────────────────────────────────

    public static View checklist(Context context,
            TranscriptModels.ChecklistData data) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        int completed = 0;
        for (TranscriptModels.ChecklistItem item : data.items) {
            if ("completed".equals(item.status)) completed++;
        }
        column.addView(headerRow(context,
                data.title != null ? data.title : "Checklist",
                completed + "/" + data.items.size()),
                TranscriptUi.fillParams());
        for (TranscriptModels.ChecklistItem item : data.items) {
            String glyph;
            int tone;
            switch (item.status) {
                case "completed":
                    glyph = "✓";
                    tone = TranscriptUi.OK;
                    break;
                case "in_progress":
                    glyph = "◐";
                    tone = TranscriptUi.ACCENT;
                    break;
                default:
                    glyph = "○";
                    tone = TranscriptUi.TEXT_FAINT;
                    break;
            }
            int textTone = "completed".equals(item.status)
                    ? TranscriptUi.TEXT_MUTED : TranscriptUi.TEXT_PRIMARY;
            column.addView(statusLine(context, glyph, tone, item.content,
                    textTone), TranscriptUi.fillParams());
        }
        return column;
    }

    // ── Task ────────────────────────────────────────────────────────────

    public static View task(Context context, TranscriptModels.TaskData data) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(TranscriptUi.sectionLabel(context, "Coding task"),
                TranscriptUi.wrapParams());
        TextView title = TranscriptUi.text(context, data.title, 14f,
                TranscriptUi.TEXT_STRONG);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams params = TranscriptUi.fillParams();
        params.topMargin = dp(context, 2);
        column.addView(title, params);
        return column;
    }

    // ── Background swatches ─────────────────────────────────────────────

    /** Ember-family + neutral presets; a tap asks the agent's BACKGROUND
     *  action to apply the color (see TranscriptActions.backgroundPick). */
    private static final int[] BACKGROUND_PRESETS = {
            0xFF000000, 0xFF1A0C06, 0xFF7A2D0C, 0xFFEF5A1F, 0xFFFF7A3D,
            0xFF15171E, 0xFF2C2F3A, 0xFFF2F2F5,
    };

    public static View background(Context context, ActionSink sink) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(TranscriptUi.sectionLabel(context, "Background"),
                TranscriptUi.wrapParams());
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        for (int color : BACKGROUND_PRESETS) {
            View swatch = TranscriptUi.swatch(context, color);
            String hex = TranscriptUi.cssHex(color);
            swatch.setOnClickListener(
                    v -> sink.send(TranscriptActions.backgroundPick(hex)));
            row.addView(swatch);
        }
        HorizontalScrollView scroller = new HorizontalScrollView(context);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.addView(row);
        LinearLayout.LayoutParams params = TranscriptUi.fillParams();
        params.topMargin = dp(context, 8);
        column.addView(scroller, params);
        return column;
    }

    // ── Permission card ─────────────────────────────────────────────────

    public static View permission(Context context,
            TranscriptModels.PermissionSegment data, ActionSink sink) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(TranscriptUi.sectionLabel(context, "Permission"),
                TranscriptUi.wrapParams());
        TextView title = TranscriptUi.text(context,
                permissionLabel(data.permission), 14f,
                TranscriptUi.TEXT_STRONG);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleParams = TranscriptUi.fillParams();
        titleParams.topMargin = dp(context, 2);
        column.addView(title, titleParams);
        if (!TextUtils.isEmpty(data.reason)) {
            TextView reason = TranscriptUi.text(context, data.reason, 12f,
                    TranscriptUi.TEXT_MUTED);
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = dp(context, 4);
            column.addView(reason, params);
        }

        LinearLayout buttons = new LinearLayout(context);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        final boolean[] decided = {false};
        TextView grant = TranscriptUi.primaryButton(context, "Grant access");
        grant.setOnClickListener(v -> {
            if (decided[0]) return;
            decided[0] = true;
            grant.setText("✓ Granted");
            lockRow(buttons, grant);
            sink.send(TranscriptActions.permissionGranted(data.feature,
                    data.permission));
        });
        buttons.addView(grant, TranscriptUi.wrapParams());
        if (data.fallbackOffered) {
            TextView fallback = TranscriptUi.chip(context, "Use fallback");
            fallback.setOnClickListener(v -> {
                if (decided[0]) return;
                decided[0] = true;
                lockRow(buttons, fallback);
                TranscriptUi.markChipSelected(context, fallback);
                sink.send(TranscriptActions.permissionFallback(data.feature,
                        data.permission));
            });
            LinearLayout.LayoutParams params = TranscriptUi.wrapParams();
            params.leftMargin = dp(context, 10);
            params.gravity = Gravity.CENTER_VERTICAL;
            buttons.addView(fallback, params);
        }
        LinearLayout.LayoutParams buttonParams = TranscriptUi.wrapParams();
        buttonParams.topMargin = dp(context, 10);
        column.addView(buttons, buttonParams);
        return column;
    }

    // ── Secret masked field ─────────────────────────────────────────────

    public static View secret(Context context,
            TranscriptModels.SecretRequest data, ActionSink sink) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.addView(headerRow(context, secretTitle(data.key),
                statusLabel(data.status)), TranscriptUi.fillParams());
        if (!TextUtils.isEmpty(data.reason)) {
            TextView reason = TranscriptUi.text(context, data.reason, 12f,
                    TranscriptUi.TEXT_MUTED);
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = dp(context, 4);
            column.addView(reason, params);
        }
        // Collection is gated exactly like the DOM block: pending status, a
        // `secret` form, and delivery sanctioning this channel.
        boolean collectable = "pending".equals(data.status)
                && "secret".equals(data.formKind)
                && data.canCollectInChannel
                && !data.fields.isEmpty();
        if (!collectable) return column;

        Map<String, EditText> inputs = new LinkedHashMap<>();
        for (TranscriptModels.SecretField fieldSpec : data.fields) {
            TextView label = TranscriptUi.text(context, fieldSpec.label, 12f,
                    TranscriptUi.TEXT_PRIMARY);
            label.setTypeface(Typeface.DEFAULT_BOLD);
            LinearLayout.LayoutParams labelParams = TranscriptUi.fillParams();
            labelParams.topMargin = dp(context, 10);
            column.addView(label, labelParams);
            EditText input = field(context, "",
                    "secret".equals(fieldSpec.input));
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = dp(context, 4);
            column.addView(input, params);
            inputs.put(fieldSpec.name, input);
        }
        TextView error = TranscriptUi.text(context, "", 11f,
                TranscriptUi.DANGER);
        error.setVisibility(View.GONE);
        column.addView(error, TranscriptUi.fillParams());

        TextView submit = TranscriptUi.primaryButton(context,
                data.submitLabel);
        final boolean[] saved = {false};
        submit.setOnClickListener(v -> {
            if (saved[0]) return;
            Map<String, String> values = new LinkedHashMap<>();
            for (TranscriptModels.SecretField fieldSpec : data.fields) {
                EditText input = inputs.get(fieldSpec.name);
                String value = input == null
                        ? "" : input.getText().toString().trim();
                if (fieldSpec.required && value.isEmpty()) {
                    error.setText(fieldSpec.label + " is required");
                    error.setVisibility(View.VISIBLE);
                    return;
                }
                if (!value.isEmpty()) values.put(fieldSpec.name, value);
            }
            if (values.isEmpty()) return;
            saved[0] = true;
            error.setVisibility(View.GONE);
            submit.setText("Saved");
            submit.setAlpha(0.5f);
            disableInputs(column);
            sink.send(TranscriptActions.secretSubmit(values));
        });
        LinearLayout.LayoutParams submitParams = TranscriptUi.wrapParams();
        submitParams.topMargin = dp(context, 12);
        column.addView(submit, submitParams);
        return column;
    }

    // ── Shared pieces ───────────────────────────────────────────────────

    interface ValueReader {
        Object read();
    }

    private static boolean isBlank(ValueReader reader) {
        if (reader == null) return true;
        Object value = reader.read();
        return !(value instanceof Boolean)
                && (value == null || value.toString().trim().isEmpty());
    }

    private static EditText field(Context context, String hint,
            boolean masked) {
        EditText input = new EditText(context);
        input.setHint(hint);
        input.setHintTextColor(TranscriptUi.TEXT_FAINT);
        input.setTextColor(TranscriptUi.TEXT_PRIMARY);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        input.setSingleLine(true);
        input.setBackground(TranscriptUi.rounded(context,
                TranscriptUi.FIELD_BG, 10f, TranscriptUi.HAIRLINE));
        int padH = dp(context, 12);
        int padV = dp(context, 9);
        input.setPadding(padH, padV, padH, padV);
        if (masked) {
            input.setInputType(InputType.TYPE_CLASS_TEXT
                    | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        }
        return input;
    }

    /** Dropdown built on PopupMenu — Spinner theming fights dark glass. */
    private static TextView selectAnchor(Context context,
            TranscriptModels.FormField fieldSpec,
            Map<String, ValueReader> readers) {
        TextView anchor = TranscriptUi.text(context,
                fieldSpec.placeholder != null ? fieldSpec.placeholder
                        : "Select…",
                13f, TranscriptUi.TEXT_FAINT);
        anchor.setBackground(TranscriptUi.rounded(context,
                TranscriptUi.FIELD_BG, 10f, TranscriptUi.HAIRLINE));
        int padH = dp(context, 12);
        int padV = dp(context, 9);
        anchor.setPadding(padH, padV, padH, padV);
        anchor.setClickable(true);
        anchor.setFocusable(true);
        final String[] selected = {""};
        anchor.setOnClickListener(v -> {
            PopupMenu menu = new PopupMenu(context, anchor);
            for (TranscriptModels.ChoiceOption option : fieldSpec.options) {
                menu.getMenu().add(option.label);
            }
            menu.setOnMenuItemClickListener(item -> {
                CharSequence label = item.getTitle();
                for (TranscriptModels.ChoiceOption option
                        : fieldSpec.options) {
                    if (option.label.contentEquals(label)) {
                        selected[0] = option.value;
                        anchor.setText(option.label);
                        anchor.setTextColor(TranscriptUi.TEXT_PRIMARY);
                        return true;
                    }
                }
                return true;
            });
            menu.show();
        });
        readers.put(fieldSpec.name, () -> selected[0]);
        return anchor;
    }

    private static LinearLayout headerRow(Context context, String title,
            String status) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView label = TranscriptUi.sectionLabel(context, title);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        row.addView(label, labelParams);
        TextView counter = TranscriptUi.text(context, status, 11f,
                TranscriptUi.TEXT_MUTED);
        row.addView(counter, TranscriptUi.wrapParams());
        return row;
    }

    private static View statusLine(Context context, String glyph,
            int glyphColor, String content, int textColor) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(context, 4), 0, 0);
        TextView icon = TranscriptUi.text(context, glyph, 13f, glyphColor);
        LinearLayout.LayoutParams iconParams = TranscriptUi.wrapParams();
        iconParams.rightMargin = dp(context, 8);
        row.addView(icon, iconParams);
        TextView body = TranscriptUi.text(context, content, 13f, textColor);
        row.addView(body, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    /** Fades every control in the row except the picked one (DOM parity:
     *  the confirmation stays at full opacity, the rest wash to 40%). */
    private static void lockRow(LinearLayout host, View picked) {
        for (int i = 0; i < host.getChildCount(); i++) {
            View child = host.getChildAt(i);
            child.setClickable(false);
            if (child != picked) child.setAlpha(0.4f);
        }
    }

    private static void disableInputs(LinearLayout column) {
        for (int i = 0; i < column.getChildCount(); i++) {
            View child = column.getChildAt(i);
            if (child instanceof LinearLayout) {
                disableInputs((LinearLayout) child);
            } else if (child instanceof EditText || child instanceof CheckBox
                    || child.isClickable()) {
                child.setEnabled(false);
            }
        }
    }

    private static String secretTitle(String key) {
        if (TextUtils.isEmpty(key)) return "Secure input";
        String pretty = key.replace('_', ' ').toLowerCase(Locale.US);
        return Character.toUpperCase(pretty.charAt(0)) + pretty.substring(1);
    }

    private static String statusLabel(String status) {
        switch (status) {
            case "pending":
                return "Needed";
            case "saved":
                return "Saved";
            case "failed":
                return "Failed";
            default:
                return status;
        }
    }

    /** Human labels for the common permission ids (PERMISSION_LABELS
     *  subset); unknown ids fall back to the id itself. */
    private static String permissionLabel(String id) {
        switch (id) {
            case "reminders":
                return "Reminders";
            case "calendar":
                return "Calendar";
            case "contacts":
                return "Contacts";
            case "camera":
                return "Camera";
            case "microphone":
                return "Microphone";
            case "location":
                return "Location";
            case "notifications":
                return "Notifications";
            case "photos":
                return "Photos";
            case "messages":
                return "Messages";
            case "phone":
                return "Phone";
            default:
                return id;
        }
    }
}
