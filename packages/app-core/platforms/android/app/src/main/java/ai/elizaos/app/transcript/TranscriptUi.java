/**
 * Shared visual vocabulary for the native transcript renderer: the dark-glass
 * palette (transparent list over the native ember backdrop, orange #ff7a3d as
 * the ONLY accent — no blue anywhere), dp/sp helpers, chip/button/text
 * factories, the collapsible DisclosureRow, and the markdown-lite span
 * renderer. Framework classes only (no androidx) because the app module's
 * compile classpath carries no recyclerview/material dependency and
 * build.gradle is owned by another lane.
 *
 * Markdown support is deliberately minimal and honest: `**bold**` and
 * `` `inline code` `` become spans; everything else (headings, lists, links,
 * tables) renders as plain text. Fenced code arrives as its own `code`
 * segment and never passes through here.
 */
package ai.elizaos.app.transcript;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.BackgroundColorSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class TranscriptUi {

    private TranscriptUi() {}

    // ── Palette (dark glass; orange accent ONLY) ────────────────────────

    public static final int ACCENT = 0xFFFF7A3D;
    /** DOM parity: color-mix(accent 70%, black) rest / 60% pressed. */
    public static final int ACCENT_BUTTON = 0xFFB35529;
    public static final int ACCENT_BUTTON_PRESSED = 0xFF994923;
    public static final int TEXT_PRIMARY = 0xFFEDEFF4;
    public static final int TEXT_STRONG = 0xFFF7F8FB;
    public static final int TEXT_MUTED = 0xB3FFFFFF;
    public static final int TEXT_FAINT = 0x80FFFFFF;
    public static final int OK = 0xFF7ED297;
    public static final int DANGER = 0xFFFF6B6B;
    public static final int HAIRLINE = 0x2EFFFFFF;
    public static final int HAIRLINE_STRONG = 0x4DFFFFFF;
    public static final int USER_CHIP_BG = 0xCC15171E;
    public static final int SURFACE_ROW = 0xFF2C2F3A;
    public static final int SURFACE_ROW_PRESSED = 0xFF363A46;
    public static final int CODE_BG = 0x66000000;
    public static final int FIELD_BG = 0x33000000;
    public static final int INLINE_CODE_BG = 0x33000000;

    // ── Metrics ─────────────────────────────────────────────────────────

    public static int dp(Context context, float value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value,
                context.getResources().getDisplayMetrics()));
    }

    public static LinearLayout.LayoutParams wrapParams() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    public static LinearLayout.LayoutParams fillParams() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    // ── Drawables ───────────────────────────────────────────────────────

    public static GradientDrawable rounded(Context context, int fillColor,
            float radiusDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(dp(context, radiusDp));
        if (strokeColor != 0) {
            drawable.setStroke(Math.max(1, dp(context, 1)), strokeColor);
        }
        return drawable;
    }

    // ── Text factories ──────────────────────────────────────────────────

    public static TextView text(Context context, CharSequence content,
            float sizeSp, int color) {
        TextView view = new TextView(context);
        view.setText(content);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(color);
        view.setLineSpacing(0f, 1.25f);
        return view;
    }

    /** Muted 11sp all-caps section label (the DOM's uppercase tracker). */
    public static TextView sectionLabel(Context context, String label) {
        TextView view = text(context, label.toUpperCase(), 11f, TEXT_MUTED);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setLetterSpacing(0.08f);
        return view;
    }

    /** Monospaced block for code / raw JSON, horizontally scrollable. */
    public static View codeBlock(Context context, String code) {
        TextView view = new TextView(context);
        view.setText(code);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        view.setTextColor(TEXT_PRIMARY);
        view.setTypeface(Typeface.MONOSPACE);
        int pad = dp(context, 10);
        view.setPadding(pad, pad, pad, pad);
        HorizontalScrollView scroller = new HorizontalScrollView(context);
        scroller.setHorizontalScrollBarEnabled(false);
        scroller.setBackground(rounded(context, CODE_BG, 10f, HAIRLINE));
        scroller.addView(view);
        return scroller;
    }

    // ── Chips + buttons ─────────────────────────────────────────────────

    /** Compact outline chip — the inline choice/followup vocabulary. */
    public static TextView chip(Context context, String label) {
        TextView view = text(context, label, 12f, TEXT_PRIMARY);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setSingleLine(false);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(context, 12), dp(context, 7),
                dp(context, 12), dp(context, 7));
        view.setBackground(rounded(context, 0x14FFFFFF, 999f, HAIRLINE));
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    public static void markChipSelected(Context context, TextView chip) {
        chip.setText("✓ " + chip.getText());
        chip.setTextColor(ACCENT);
        chip.setBackground(rounded(context, 0x1AFF7A3D, 999f, ACCENT));
        chip.setAlpha(1f);
    }

    /** Accent-filled primary button (orange rest → darker-orange pressed). */
    public static TextView primaryButton(Context context, String label) {
        TextView view = text(context, label, 13f, TEXT_STRONG);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(context, 16), dp(context, 9),
                dp(context, 16), dp(context, 9));
        view.setBackground(rounded(context, ACCENT_BUTTON, 10f, 0));
        view.setClickable(true);
        view.setFocusable(true);
        view.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    v.setBackground(rounded(v.getContext(),
                            ACCENT_BUTTON_PRESSED, 10f, 0));
                    break;
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    v.setBackground(rounded(v.getContext(),
                            ACCENT_BUTTON, 10f, 0));
                    break;
                default:
                    break;
            }
            // Press feedback only; the click listener still receives the tap.
            return false;
        });
        return view;
    }

    /** Full-width dark surface row — first-run choice vocabulary. */
    public static TextView surfaceRow(Context context, String label) {
        TextView view = text(context, label, 14f, TEXT_STRONG);
        view.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(context, 16), dp(context, 12),
                dp(context, 16), dp(context, 12));
        view.setBackground(rounded(context, SURFACE_ROW, 10f,
                HAIRLINE_STRONG));
        view.setClickable(true);
        view.setFocusable(true);
        return view;
    }

    // ── DisclosureRow ───────────────────────────────────────────────────

    /**
     * Collapsed-by-default disclosure: a muted header row with a chevron
     * glyph toggling a body view — the native ThinkingBlock / tool-detail
     * idiom. The body is built lazily via the supplier so heavy JSON views
     * cost nothing until first expand.
     */
    public interface ViewSupplier {
        View build(Context context);
    }

    public static LinearLayout disclosureRow(Context context, String title,
            int titleColor, ViewSupplier bodySupplier) {
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);

        TextView header = text(context, "▸ " + title, 12f, titleColor);
        header.setTypeface(Typeface.DEFAULT_BOLD);
        header.setPadding(0, dp(context, 4), dp(context, 8), dp(context, 4));
        header.setClickable(true);
        header.setFocusable(true);
        column.addView(header, wrapParams());

        final View[] body = new View[1];
        header.setOnClickListener(v -> {
            if (body[0] == null) {
                body[0] = bodySupplier.build(context);
                LinearLayout.LayoutParams params = fillParams();
                params.topMargin = dp(context, 2);
                column.addView(body[0], params);
                header.setText("▾ " + title);
                return;
            }
            boolean expanded = body[0].getVisibility() == View.VISIBLE;
            body[0].setVisibility(expanded ? View.GONE : View.VISIBLE);
            header.setText((expanded ? "▸ " : "▾ ") + title);
        });
        return column;
    }

    // ── Markdown-lite ───────────────────────────────────────────────────

    /**
     * Renders `**bold**` and `` `code` `` spans; all other markdown syntax is
     * left as literal text (documented limitation — the DOM renderer owns
     * full markdown).
     */
    public static CharSequence markdownLite(String source) {
        if (TextUtils.isEmpty(source)) return "";
        SpannableStringBuilder out = new SpannableStringBuilder();
        int i = 0;
        int length = source.length();
        while (i < length) {
            if (source.startsWith("**", i)) {
                int close = source.indexOf("**", i + 2);
                if (close > i + 2) {
                    int start = out.length();
                    out.append(source, i + 2, close);
                    out.setSpan(new StyleSpan(Typeface.BOLD), start,
                            out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = close + 2;
                    continue;
                }
            }
            if (source.charAt(i) == '`') {
                int close = source.indexOf('`', i + 1);
                if (close > i + 1) {
                    int start = out.length();
                    out.append(source, i + 1, close);
                    out.setSpan(new TypefaceSpan("monospace"), start,
                            out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    out.setSpan(new BackgroundColorSpan(INLINE_CODE_BG), start,
                            out.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                    i = close + 1;
                    continue;
                }
            }
            out.append(source.charAt(i));
            i++;
        }
        return out;
    }

    /** Small circular color swatch for the background picker. */
    public static View swatch(Context context, int color) {
        View view = new View(context);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(color);
        circle.setStroke(Math.max(1, dp(context, 1)), HAIRLINE_STRONG);
        view.setBackground(circle);
        view.setClickable(true);
        view.setFocusable(true);
        int size = dp(context, 34);
        LinearLayout.LayoutParams params =
                new LinearLayout.LayoutParams(size, size);
        params.rightMargin = dp(context, 10);
        view.setLayoutParams(params);
        return view;
    }

    public static String cssHex(int color) {
        return String.format("#%06x", color & 0xFFFFFF);
    }

    /** Transparent — the native glass/backdrop must show through the list. */
    public static void makeTransparent(View view) {
        view.setBackgroundColor(Color.TRANSPARENT);
    }
}
