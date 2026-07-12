/**
 * The native transcript list: a transparent, vertically scrolling column of
 * message rows drawn over the WebView (the native glass/backdrop shows
 * through — the list itself paints no background). User turns are
 * right-aligned dark chips; assistant turns are left, full-width, no bubble
 * chrome — matching the DOM ChatOverlay's information hierarchy.
 *
 * The host replaces the whole frame on every update (`setTranscript` is a
 * full-frame replace by contract) and this view diffs by message id: a row
 * whose fingerprint (raw message JSON) is unchanged keeps its live view — and
 * with it every in-progress interaction (choice locks, form drafts, secret
 * text, expanded disclosures). Only changed/new rows rebuild. A framework
 * ScrollView + LinearLayout hosts the rows instead of RecyclerView because
 * the app module's compile classpath has no androidx.recyclerview dependency
 * (and build.gradle is owned elsewhere); transcripts on this surface are
 * bounded, and keyed reuse keeps rebuild cost proportional to the change.
 */
package ai.elizaos.app.transcript;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

public class TranscriptView extends ScrollView {

    private final LinearLayout column;
    private final TranscriptWidgets.ActionSink sink;
    /** Live row views + the fingerprint they were built from, by message id. */
    private final Map<String, View> rowsById = new HashMap<>();
    private final Map<String, String> fingerprintsById = new HashMap<>();
    private View statusRow;
    private ValueAnimator statusPulse;

    public TranscriptView(Context context, TranscriptWidgets.ActionSink sink) {
        super(context);
        this.sink = sink;
        TranscriptUi.makeTransparent(this);
        setVerticalScrollBarEnabled(false);
        setFillViewport(true);
        setClipToPadding(false);
        column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        int padH = TranscriptUi.dp(context, 16);
        column.setPadding(padH, TranscriptUi.dp(context, 12), padH,
                TranscriptUi.dp(context, 16));
        addView(column, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /** Main-thread only. */
    public void render(TranscriptModels.Frame frame) {
        boolean wasAtBottom = isAtBottom();
        if (statusRow != null) {
            column.removeView(statusRow);
            statusRow = null;
        }
        if (statusPulse != null) {
            statusPulse.cancel();
            statusPulse = null;
        }

        Set<String> liveIds = new LinkedHashSet<>();
        int position = 0;
        for (TranscriptModels.Message message : frame.messages) {
            liveIds.add(message.id);
            View existing = rowsById.get(message.id);
            String previousFingerprint = fingerprintsById.get(message.id);
            View row;
            if (existing != null
                    && message.fingerprint.equals(previousFingerprint)) {
                row = existing;
            } else {
                if (existing != null) column.removeView(existing);
                row = buildRow(message);
                rowsById.put(message.id, row);
                fingerprintsById.put(message.id, message.fingerprint);
            }
            placeRowAt(row, position);
            position++;
        }
        // Drop rows whose messages vanished from the frame.
        for (Map.Entry<String, View> entry
                : new HashMap<>(rowsById).entrySet()) {
            if (!liveIds.contains(entry.getKey())) {
                column.removeView(entry.getValue());
                rowsById.remove(entry.getKey());
                fingerprintsById.remove(entry.getKey());
            }
        }
        while (column.getChildCount() > position) {
            column.removeViewAt(column.getChildCount() - 1);
        }

        if (frame.turnStatus != null) {
            statusRow = buildTurnStatusRow(frame.turnStatus);
            column.addView(statusRow, TranscriptUi.fillParams());
        }

        if (wasAtBottom) {
            // smoothScrollTo, never fullScroll: fullScroll hands FOCUS to the
            // bottommost view (or reclaims it), blurring a form/secret
            // EditText mid-typing and dismissing the IME on every frame.
            post(() -> smoothScrollTo(0, getChildAt(0).getBottom()));
        }
    }

    private void placeRowAt(View row, int index) {
        int current = column.indexOfChild(row);
        if (current == index) return;
        if (current >= 0) column.removeViewAt(current);
        column.addView(row, Math.min(index, column.getChildCount()),
                rowParams(row));
    }

    private LinearLayout.LayoutParams rowParams(View row) {
        LinearLayout.LayoutParams params = row.getLayoutParams()
                instanceof LinearLayout.LayoutParams
                        ? (LinearLayout.LayoutParams) row.getLayoutParams()
                        : TranscriptUi.fillParams();
        params.width = ViewGroup.LayoutParams.MATCH_PARENT;
        params.topMargin = TranscriptUi.dp(getContext(), 10);
        return params;
    }

    private boolean isAtBottom() {
        if (column.getHeight() == 0) return true;
        return getScrollY() + getHeight()
                >= column.getHeight() - TranscriptUi.dp(getContext(), 48);
    }

    // ── Rows ────────────────────────────────────────────────────────────

    private View buildRow(TranscriptModels.Message message) {
        return message.isUser() ? buildUserRow(message)
                : buildAssistantRow(message);
    }

    /** Right-aligned dark chip; user turns are always plain text. */
    private View buildUserRow(TranscriptModels.Message message) {
        Context context = getContext();
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.END);

        StringBuilder textContent = new StringBuilder();
        for (TranscriptModels.Segment segment : message.segments) {
            if (segment instanceof TranscriptModels.TextSegment) {
                textContent.append(
                        ((TranscriptModels.TextSegment) segment).text);
            }
        }
        TextView chip = TranscriptUi.text(context,
                textContent.toString().trim(), 14f, TranscriptUi.TEXT_STRONG);
        chip.setBackground(TranscriptUi.rounded(context,
                TranscriptUi.USER_CHIP_BG, 18f, TranscriptUi.HAIRLINE));
        int padH = TranscriptUi.dp(context, 14);
        int padV = TranscriptUi.dp(context, 9);
        chip.setPadding(padH, padV, padH, padV);
        chip.setMaxWidth((int) (getResources().getDisplayMetrics().widthPixels
                * 0.78f));
        row.addView(chip, TranscriptUi.wrapParams());
        return row;
    }

    /** Left, full-width column: side channels above, segments in order. */
    private View buildAssistantRow(TranscriptModels.Message message) {
        Context context = getContext();
        LinearLayout columnRow = new LinearLayout(context);
        columnRow.setOrientation(LinearLayout.VERTICAL);

        if (!TextUtils.isEmpty(message.reasoning)) {
            columnRow.addView(TranscriptUi.disclosureRow(context, "Thinking",
                    TranscriptUi.TEXT_MUTED, c -> {
                        TextView body = TranscriptUi.text(c, message.reasoning,
                                13f, TranscriptUi.TEXT_MUTED);
                        body.setTypeface(Typeface.defaultFromStyle(
                                Typeface.ITALIC));
                        return body;
                    }), TranscriptUi.fillParams());
        }
        for (TranscriptModels.ToolEvent event : message.toolEvents) {
            columnRow.addView(buildToolRow(event), TranscriptUi.fillParams());
        }

        for (TranscriptModels.Segment segment : message.segments) {
            View segmentView = buildSegment(segment);
            if (segmentView == null) continue;
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = TranscriptUi.dp(context, 6);
            columnRow.addView(segmentView, params);
        }

        if (message.secretRequest != null) {
            LinearLayout.LayoutParams params = TranscriptUi.fillParams();
            params.topMargin = TranscriptUi.dp(context, 8);
            columnRow.addView(TranscriptWidgets.secret(context,
                    message.secretRequest, sink), params);
        }
        if (message.failureKind != null) {
            LinearLayout.LayoutParams params = TranscriptUi.wrapParams();
            params.topMargin = TranscriptUi.dp(context, 8);
            columnRow.addView(buildFailureRow(message.failureKind), params);
        }
        if (message.streaming) {
            columnRow.addView(buildStreamingDot(), TranscriptUi.wrapParams());
        }
        return columnRow;
    }

    // ── Segments ────────────────────────────────────────────────────────

    private View buildSegment(TranscriptModels.Segment segment) {
        Context context = getContext();
        if (segment instanceof TranscriptModels.TextSegment) {
            String content =
                    ((TranscriptModels.TextSegment) segment).text.trim();
            if (content.isEmpty()) return null;
            return TranscriptUi.text(context,
                    TranscriptUi.markdownLite(content), 14f,
                    TranscriptUi.TEXT_PRIMARY);
        }
        if (segment instanceof TranscriptModels.CodeSegment) {
            TranscriptModels.CodeSegment code =
                    (TranscriptModels.CodeSegment) segment;
            if (code.inline) {
                return TranscriptUi.text(context,
                        TranscriptUi.markdownLite("`" + code.code + "`"), 14f,
                        TranscriptUi.TEXT_PRIMARY);
            }
            return TranscriptUi.codeBlock(context, code.code);
        }
        if (segment instanceof TranscriptModels.WidgetSegment) {
            return buildWidget((TranscriptModels.WidgetSegment) segment);
        }
        if (segment instanceof TranscriptModels.PermissionSegment) {
            return TranscriptWidgets.permission(context,
                    (TranscriptModels.PermissionSegment) segment, sink);
        }
        if (segment instanceof TranscriptModels.UiSpecSegment) {
            String raw = ((TranscriptModels.UiSpecSegment) segment).raw;
            return TranscriptUi.disclosureRow(context, "Interactive UI",
                    TranscriptUi.TEXT_MUTED,
                    c -> TranscriptUi.codeBlock(c, raw));
        }
        if (segment instanceof TranscriptModels.ConfigSegment) {
            String pluginId =
                    ((TranscriptModels.ConfigSegment) segment).pluginId;
            TextView row = TranscriptUi.chip(getContext(),
                    "Configure " + pluginId + " ›");
            row.setOnClickListener(v -> sink.send(
                    TranscriptActions.openPluginConfig(pluginId)));
            return row;
        }
        // Unknown segment kind → honest fallback row, never a crash.
        TranscriptModels.UnknownSegment unknown =
                (TranscriptModels.UnknownSegment) segment;
        return TranscriptUi.text(context,
                "Unsupported content (" + unknown.kind + ")", 12f,
                TranscriptUi.TEXT_FAINT);
    }

    private View buildWidget(TranscriptModels.WidgetSegment widget) {
        Context context = getContext();
        if (widget.choice != null) {
            return TranscriptWidgets.choice(context, widget.choice, sink);
        }
        if (widget.followups != null) {
            return TranscriptWidgets.followups(context, widget.followups,
                    sink);
        }
        if (widget.form != null) {
            return TranscriptWidgets.form(context, widget.form, sink);
        }
        if (widget.workflow != null) {
            return TranscriptWidgets.workflow(context, widget.workflow);
        }
        if (widget.checklist != null) {
            return TranscriptWidgets.checklist(context, widget.checklist);
        }
        if (widget.task != null) {
            return TranscriptWidgets.task(context, widget.task);
        }
        if (widget.background != null) {
            return TranscriptWidgets.background(context, sink);
        }
        return TranscriptUi.text(context,
                "Unsupported widget (" + widget.widgetKind + ")", 12f,
                TranscriptUi.TEXT_FAINT);
    }

    // ── Side-channel rows ───────────────────────────────────────────────

    private View buildToolRow(TranscriptModels.ToolEvent event) {
        Context context = getContext();
        String glyph;
        int tone;
        if ("running".equals(event.status)) {
            glyph = "◐";
            tone = TranscriptUi.ACCENT;
        } else if ("error".equals(event.status)
                || "tool_error".equals(event.type)) {
            glyph = "✕";
            tone = TranscriptUi.DANGER;
        } else {
            glyph = "✓";
            tone = TranscriptUi.OK;
        }
        StringBuilder title = new StringBuilder(glyph).append("  ")
                .append(event.actionName);
        if (event.durationMs >= 0) {
            title.append(" · ").append(event.durationMs).append("ms");
        }
        boolean hasDetail = event.argsJson != null || event.resultJson != null
                || event.error != null;
        if (!hasDetail) {
            return TranscriptUi.text(context, title.toString(), 12f, tone);
        }
        return TranscriptUi.disclosureRow(context, title.toString(), tone,
                c -> {
                    StringBuilder detail = new StringBuilder();
                    if (event.argsJson != null) {
                        detail.append("args ").append(event.argsJson);
                    }
                    if (event.resultJson != null) {
                        if (detail.length() > 0) detail.append("\n\n");
                        detail.append("result ").append(event.resultJson);
                    }
                    if (event.error != null) {
                        if (detail.length() > 0) detail.append("\n\n");
                        detail.append("error ").append(event.error);
                    }
                    return TranscriptUi.codeBlock(c, detail.toString());
                });
    }

    /** Display-only failure state; retry stays owned by the DOM composer. */
    private View buildFailureRow(String failureKind) {
        Context context = getContext();
        TextView pill = TranscriptUi.text(context,
                "⚠ " + failureKind.replace('_', ' '), 12f,
                TranscriptUi.DANGER);
        pill.setTypeface(Typeface.DEFAULT_BOLD);
        int padH = TranscriptUi.dp(context, 10);
        int padV = TranscriptUi.dp(context, 5);
        pill.setPadding(padH, padV, padH, padV);
        pill.setBackground(TranscriptUi.rounded(context, 0x1AFF6B6B, 999f,
                0x40FF6B6B));
        return pill;
    }

    private View buildStreamingDot() {
        Context context = getContext();
        TextView dot = TranscriptUi.text(context, "●", 12f,
                TranscriptUi.ACCENT);
        dot.setPadding(0, TranscriptUi.dp(context, 4), 0, 0);
        pulse(dot);
        return dot;
    }

    private View buildTurnStatusRow(TranscriptModels.TurnStatus status) {
        Context context = getContext();
        String label = status.label != null ? status.label
                : status.kind + "…";
        TextView row = TranscriptUi.text(context, label, 12f,
                TranscriptUi.TEXT_MUTED);
        row.setPadding(0, TranscriptUi.dp(context, 8), 0, 0);
        statusPulse = pulse(row);
        return row;
    }

    private ValueAnimator pulse(View view) {
        if (!ValueAnimator.areAnimatorsEnabled()) return null;
        ValueAnimator animator = ValueAnimator.ofFloat(0.35f, 1f);
        animator.setDuration(900);
        animator.setRepeatMode(ValueAnimator.REVERSE);
        animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.addUpdateListener(
                a -> view.setAlpha((float) a.getAnimatedValue()));
        // Streaming rows rebuild per token; an INFINITE animator must die
        // with its view or every rebuild leaks one onto the Choreographer.
        view.addOnAttachStateChangeListener(
                new OnAttachStateChangeListener() {
                    @Override
                    public void onViewAttachedToWindow(View v) {}

                    @Override
                    public void onViewDetachedFromWindow(View v) {
                        animator.cancel();
                    }
                });
        animator.start();
        return animator;
    }

    /** Stop infinite animators so a detached view can't pin the activity. */
    @Override
    protected void onDetachedFromWindow() {
        if (statusPulse != null) {
            statusPulse.cancel();
            statusPulse = null;
        }
        super.onDetachedFromWindow();
    }
}
