/**
 * Presents and controls live Telecom calls without requiring agent or WebView startup.
 * The host's non-exported subclass accepts only app-owned call IDs. Telecom callbacks drive
 * its state, including call removal, audio routing and multiple simultaneous calls.
 * {@link TelecomCallPresentation} decides what a call shows and offers; this class draws it.
 * The view tree is rebuilt only when what it shows changes; the call timer updates one line.
 */
package ai.eliza.plugins.phone;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.ContactsContract;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.PhoneAccount;
import android.telecom.VideoProfile;
import android.telephony.PhoneNumberUtils;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public abstract class TelecomCallActivity extends Activity {
    /** The screen's accessibility title, for example the product name. It is not drawn. */
    protected abstract String title();

    private static final String TAG = "TelecomCallActivity";
    private static final int SECONDARY = 0xFFA8A8A8;
    private static final int NEUTRAL = 0xFF1C1C1C;
    private static final int RED = 0xFFE5383B;
    private static final int GREEN = 0xFF1E9E4A;
    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private final Runnable changed = this::render;
    private String selected;
    private final Handler toneHandler = new Handler(Looper.getMainLooper());
    private final ToneSession tones = new ToneSession(new ToneSession.Output() {
        @Override public boolean play(String id, char digit) { return TelecomCallService.playDtmfTone(id, digit); }
        @Override public void stop(String id) { TelecomCallService.stopDtmfTone(id); }
    });
    private final Handler clock = new Handler(Looper.getMainLooper());
    private final Runnable tick = this::onTick;
    private boolean started, ticking, keypadOpen;
    /** The call the open keypad and its typed digits belong to. */
    private String keypadCall;
    private final StringBuilder typed = new StringBuilder();
    /** Everything the view tree on screen was built from; an equal value needs no rebuild. */
    private String built;
    private String numberWhenNamed;
    /** Contact names by call ID and number. An empty name is a lookup that found none or is running. */
    private final Map<String, String> names = new HashMap<>();
    private ExecutorService lookups;
    private LinearLayout content;
    private TextView secondary, digits;

    /** Owns one call's tone; delayed cleanup may never stop its replacement. */
    public static final class ToneSession {
        public interface Output {
            boolean play(String id, char digit);
            void stop(String id);
        }
        private final Output output;
        private String callId;
        private Object admission;

        public ToneSession(Output output) { this.output = output; }

        public Runnable play(String id, char digit) {
            stop();
            if (!output.play(id, digit)) return () -> {};
            callId = id;
            Object current = new Object();
            admission = current;
            return () -> { if (admission == current) stop(); };
        }

        public void retain(String id, boolean active) {
            if (!active || !id.equals(callId)) stop();
        }

        public void stop() {
            String previous = callId;
            callId = null;
            admission = null;
            if (previous != null) output.stop(previous);
        }
    }

    /** Who a call is with: a name when one is known, and the number as the owner would write it. */
    private static final class Caller {
        final String name, number;

        Caller(String name, String number) { this.name = name; this.number = number; }

        String shown() { return name != null ? name : number != null ? number : "Unknown"; }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(true);
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        setTitle(title());
        Window window = getWindow();
        window.setStatusBarColor(Color.BLACK);
        window.setNavigationBarColor(Color.BLACK);
        // The screen is black whatever the host theme: system bar icons stay light.
        View decor = window.getDecorView();
        int lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() & ~lightBars);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.BLACK);
        scroll.addView(content, new ScrollView.LayoutParams(MATCH, WRAP));
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        if (state == null) acceptIntent(getIntent());
        else selected = state.getString("callId");
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        acceptIntent(intent);
        render();
    }

    @Override public void onStart() {
        super.onStart();
        started = true;
        TelecomCallService.observe(changed);
        render();
    }

    @Override public void onStop() {
        started = false;
        stopClock();
        tones.stop();
        toneHandler.removeCallbacksAndMessages(null);
        TelecomCallService.unobserve(changed);
        super.onStop();
    }

    @Override public void onDestroy() {
        if (lookups != null) lookups.shutdownNow();
        super.onDestroy();
    }

    @Override public void onSaveInstanceState(Bundle state) {
        state.putString("callId", selected);
        super.onSaveInstanceState(state);
    }

    private void acceptIntent(Intent intent) {
        tones.stop();
        selected = intent.getStringExtra("callId");
        Call call = TelecomCallService.call(selected);
        if (call == null) return;
        String command = intent.getStringExtra("command");
        if ("answer".equals(command) && call.getState() == Call.STATE_RINGING) {
            TelecomCallService.answerCall(selected, VideoProfile.STATE_AUDIO_ONLY);
        } else if ("reject".equals(command) && call.getState() == Call.STATE_RINGING) {
            TelecomCallService.rejectCall(selected, false, null);
        } else if ("disconnect".equals(command)) {
            TelecomCallService.disconnectCall(selected);
        }
    }

    private void render() {
        List<String> ids = TelecomCallService.callIds();
        if (ids.isEmpty()) { leave(); return; }
        if (!ids.contains(selected)) selected = ids.get(0);
        Call call = TelecomCallService.call(selected);
        if (call == null) { leave(); return; }
        String id = selected;
        int state = call.getState();
        tones.retain(id, state == Call.STATE_ACTIVE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setTurnScreenOn(state == Call.STATE_RINGING);
        else if (state == Call.STATE_RINGING) getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        for (Iterator<String> keys = names.keySet().iterator(); keys.hasNext(); ) {
            String key = keys.next();
            if (!ids.contains(key.substring(0, key.indexOf('\n')))) keys.remove();
        }
        // The keypad and its digits belong to one active call; they close when it is held or replaced.
        if (!id.equals(keypadCall)) {
            keypadCall = id;
            keypadOpen = false;
            typed.setLength(0);
        }
        if (state != Call.STATE_ACTIVE) keypadOpen = false;
        Call.Details details = call.getDetails();
        Caller caller = caller(id, details);
        CallAudioState audio = TelecomCallService.audioState();
        int phoneRoutes = audio == null ? 0 : audio.getSupportedRouteMask() & CallAudioState.ROUTE_WIRED_OR_EARPIECE;
        TelecomCallPresentation.Controls controls = TelecomCallPresentation.controls(state, audio != null,
            audio != null && (audio.getSupportedRouteMask() & CallAudioState.ROUTE_SPEAKER) != 0 && phoneRoutes != 0,
            details != null && details.can(Call.Details.CAPABILITY_HOLD));
        StringBuilder shown = new StringBuilder().append(id).append('\n').append(state).append('\n').append(keypadOpen)
            .append('\n').append(caller.name).append('\n').append(caller.number)
            .append('\n').append(controls.mute && audio.isMuted())
            .append('\n').append(controls.speaker ? audio.getRoute() + "/" + phoneRoutes : "")
            .append('\n').append(controls.hold);
        String[] chips = new String[ids.size()];
        for (int i = 0; i < chips.length; i++) {
            String other = ids.get(i);
            Call otherCall = other.equals(id) ? null : TelecomCallService.call(other);
            if (otherCall == null) continue;
            chips[i] = TelecomCallPresentation.chipLabel(caller(other, otherCall.getDetails()).shown(), otherCall.getState());
            shown.append('\n').append(other).append('\n').append(chips[i]);
        }
        if (!shown.toString().equals(built)) {
            built = shown.toString();
            build(id, state, caller, controls, audio, phoneRoutes, ids, chips);
        }
        numberWhenNamed = caller.name == null ? null : caller.number;
        showSecondary(state, details);
        if (started && state == Call.STATE_ACTIVE) schedule(details);
        else stopClock();
    }

    private void leave() {
        tones.stop();
        stopClock();
        finish();
    }

    // ---- caller identity -------------------------------------------------------

    private Caller caller(String id, Call.Details details) {
        Uri handle = details == null ? null : details.getHandle();
        String raw = handle == null ? null : clean(handle.getSchemeSpecificPart());
        boolean telephone = raw != null && PhoneAccount.SCHEME_TEL.equals(handle.getScheme());
        String number = raw;
        if (telephone) {
            String formatted = PhoneNumberUtils.formatNumber(raw, Locale.getDefault().getCountry());
            if (formatted != null && !formatted.isEmpty()) number = formatted;
        }
        String name = details == null ? null : clean(details.getCallerDisplayName());
        if (name == null && details != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            name = clean(details.getContactDisplayName());
        }
        // A network that sends the number as the caller's name has named nobody.
        if (name != null && (name.equals(raw) || name.equals(number))) name = null;
        if (name == null && telephone) {
            String key = id + '\n' + raw;
            if (names.containsKey(key)) name = clean(names.get(key));
            else if (checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) lookUp(key, raw);
        }
        return new Caller(name, number);
    }

    static String clean(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Reads the contact's name off the main thread, once per call and number, then shows it. */
    private void lookUp(String key, String number) {
        names.put(key, "");
        if (lookups == null) lookups = Executors.newSingleThreadExecutor();
        ContentResolver resolver = getApplicationContext().getContentResolver();
        lookups.execute(() -> {
            String found = contactName(resolver, number);
            runOnUiThread(() -> {
                if (found == null || isDestroyed() || !names.containsKey(key)) return;
                names.put(key, found);
                if (started) render();
            });
        });
    }

    static String contactName(ContentResolver resolver, String number) {
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cursor = resolver.query(uri, new String[] {ContactsContract.PhoneLookup.DISPLAY_NAME}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? clean(cursor.getString(0)) : null;
        } catch (SecurityException | IllegalArgumentException e) {
            // Contacts access was withdrawn during the call, or this device has no contacts
            // provider. The screen keeps showing the number.
            Log.w(TAG, "Contact lookup unavailable", e);
            return null;
        }
    }

    // ---- call timer ------------------------------------------------------------

    private void showSecondary(int state, Call.Details details) {
        if (secondary == null) return;
        String line = TelecomCallPresentation.secondaryLine(state, numberWhenNamed,
            details == null ? 0 : details.getConnectTimeMillis(), System.currentTimeMillis());
        if (!line.contentEquals(secondary.getText())) secondary.setText(line);
    }

    private void onTick() {
        ticking = false;
        Call call = TelecomCallService.call(selected);
        if (!started || call == null || call.getState() != Call.STATE_ACTIVE) return;
        Call.Details details = call.getDetails();
        showSecondary(Call.STATE_ACTIVE, details);
        schedule(details);
    }

    private void schedule(Call.Details details) {
        if (ticking) return;
        ticking = true;
        clock.postDelayed(tick, TelecomCallPresentation.untilNextSecond(
            details == null ? 0 : details.getConnectTimeMillis(), System.currentTimeMillis()));
    }

    private void stopClock() {
        ticking = false;
        clock.removeCallbacks(tick);
    }

    // ---- views -----------------------------------------------------------------

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static LinearLayout.LayoutParams below(int width, int height, int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(width, height);
        params.topMargin = topMargin;
        return params;
    }

    private TextView line(int size, int color) {
        TextView text = new TextView(this);
        text.setTextSize(size);
        text.setTextColor(color);
        text.setGravity(Gravity.CENTER);
        text.setSingleLine(true);
        text.setEllipsize(TextUtils.TruncateAt.END);
        return text;
    }

    private static GradientDrawable shape(int form, int color, float radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(form);
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    /** A fill that answers a touch: a dark fill lightens and a light one darkens while pressed. */
    private static Drawable pressable(int form, int color, float radius) {
        boolean light = Color.red(color) * 299 + Color.green(color) * 587 + Color.blue(color) * 114 > 150000;
        int toward = light ? 0 : 255;
        int pressed = Color.rgb(Color.red(color) + (toward - Color.red(color)) * 22 / 100,
            Color.green(color) + (toward - Color.green(color)) * 22 / 100,
            Color.blue(color) + (toward - Color.blue(color)) * 22 / 100);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[] {android.R.attr.state_pressed}, shape(form, pressed, radius));
        states.addState(new int[] {}, shape(form, color, radius));
        return states;
    }

    private ImageButton round(int fill, int glyph, int ink, int glyphSize, String description, Runnable action) {
        ImageButton button = new ImageButton(this);
        button.setBackground(pressable(GradientDrawable.OVAL, fill, 0));
        button.setImageDrawable(new Glyph(glyph, ink, dp(glyphSize)));
        button.setScaleType(ImageView.ScaleType.CENTER);
        button.setPadding(0, 0, 0, 0);
        button.setContentDescription(description);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    /** One of the evenly spaced 68dp controls. A toggle that is on is white with a black icon. */
    private void control(LinearLayout row, int glyph, String description, boolean on, Runnable action) {
        ImageButton button = round(on ? Color.WHITE : NEUTRAL, glyph, on ? Color.BLACK : Color.WHITE, 28, description, action);
        button.setSelected(on);
        FrameLayout cell = new FrameLayout(this);
        cell.addView(button, new FrameLayout.LayoutParams(dp(68), dp(68), Gravity.CENTER));
        row.addView(cell, new LinearLayout.LayoutParams(0, WRAP, 1));
    }

    private void build(String id, int state, Caller caller, TelecomCallPresentation.Controls controls,
            CallAudioState audio, int phoneRoutes, List<String> ids, String[] chips) {
        content.removeAllViews();
        content.setPadding(dp(24), dp(keypadOpen ? 32 : 96), dp(24), dp(48));
        secondary = line(17, SECONDARY);
        secondary.setFontFeatureSettings("tnum");
        secondary.setMinHeight(dp(24));
        if (keypadOpen) {
            content.addView(secondary, new LinearLayout.LayoutParams(MATCH, WRAP));
            digits = line(28, Color.WHITE);
            digits.setEllipsize(TextUtils.TruncateAt.START);
            digits.setMinHeight(dp(40));
            digits.setText(typed);
            content.addView(digits, below(MATCH, WRAP, dp(8)));
            for (String keys : new String[] {"123", "456", "789", "*0#"}) {
                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER);
                for (char digit : keys.toCharArray()) row.addView(key(id, digit));
                content.addView(row, below(WRAP, WRAP, dp(14)));
            }
        } else {
            digits = null;
            TextView avatar = line(36, Color.WHITE);
            avatar.setBackground(shape(GradientDrawable.OVAL, NEUTRAL, 0));
            avatar.setTypeface(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? Typeface.create(Typeface.DEFAULT, 600, false)
                : Typeface.create("sans-serif-medium", Typeface.NORMAL));
            avatar.setText(TelecomCallPresentation.initials(caller.name, caller.number != null));
            avatar.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            content.addView(avatar, new LinearLayout.LayoutParams(dp(112), dp(112)));
            TextView name = line(34, Color.WHITE);
            name.setTypeface(Typeface.SERIF);
            name.setText(caller.shown());
            content.addView(name, below(MATCH, WRAP, dp(20)));
            content.addView(secondary, below(MATCH, WRAP, dp(6)));
            LinearLayout others = new LinearLayout(this);
            for (int i = 0; i < chips.length; i++) {
                if (chips[i] != null) others.addView(chip(ids.get(i), chips[i]));
            }
            if (others.getChildCount() > 0) {
                HorizontalScrollView strip = new HorizontalScrollView(this);
                strip.setHorizontalScrollBarEnabled(false);
                strip.addView(others);
                content.addView(strip, below(WRAP, WRAP, dp(16)));
            }
        }
        View spacer = new View(this);
        spacer.setMinimumHeight(dp(24));
        content.addView(spacer, new LinearLayout.LayoutParams(MATCH, 0, 1));
        if (controls.answer || controls.decline) {
            LinearLayout row = new LinearLayout(this);
            row.setPadding(dp(28), 0, dp(28), 0);
            row.addView(round(RED, Glyph.HANG_UP, Color.WHITE, 34, "Decline",
                () -> TelecomCallService.rejectCall(id, false, null)), new LinearLayout.LayoutParams(dp(78), dp(78)));
            row.addView(new View(this), new LinearLayout.LayoutParams(0, 0, 1));
            row.addView(round(GREEN, Glyph.PHONE, Color.WHITE, 34, "Answer",
                () -> TelecomCallService.answerCall(id, VideoProfile.STATE_AUDIO_ONLY)), new LinearLayout.LayoutParams(dp(78), dp(78)));
            content.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
        }
        if (!controls.end) return;
        LinearLayout row = new LinearLayout(this);
        if (controls.mute) {
            boolean muted = audio.isMuted();
            control(row, Glyph.MUTE, TelecomCallPresentation.toggleDescription("Mute", muted), muted,
                () -> TelecomCallService.mute(!muted));
        }
        if (controls.keypad) {
            control(row, Glyph.KEYPAD, TelecomCallPresentation.toggleDescription("Keypad", keypadOpen), keypadOpen, () -> {
                keypadOpen = !keypadOpen;
                render();
            });
        }
        if (controls.speaker) {
            boolean speaker = audio.getRoute() == CallAudioState.ROUTE_SPEAKER;
            control(row, Glyph.SPEAKER, TelecomCallPresentation.toggleDescription("Speaker", speaker), speaker,
                () -> TelecomCallService.route(speaker ? phoneRoutes : CallAudioState.ROUTE_SPEAKER));
        }
        if (controls.hold) {
            boolean held = state == Call.STATE_HOLDING;
            control(row, Glyph.HOLD, TelecomCallPresentation.toggleDescription("Hold", held), held,
                () -> TelecomCallService.holdCall(id, !held));
        }
        boolean hasRow = row.getChildCount() > 0;
        if (hasRow) content.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));
        content.addView(round(RED, Glyph.HANG_UP, Color.WHITE, 34, "End call",
            () -> TelecomCallService.disconnectCall(id)), below(dp(78), dp(78), hasRow ? dp(44) : 0));
    }

    private Button key(String id, char digit) {
        Button key = new Button(this);
        key.setText(String.valueOf(digit));
        key.setTextSize(28);
        key.setTextColor(Color.WHITE);
        key.setAllCaps(false);
        key.setPadding(0, 0, 0, 0);
        key.setMinWidth(0);
        key.setMinHeight(0);
        key.setMinimumWidth(0);
        key.setMinimumHeight(0);
        key.setStateListAnimator(null);
        key.setBackground(pressable(GradientDrawable.OVAL, NEUTRAL, 0));
        if (digit == '*') key.setContentDescription("Star");
        else if (digit == '#') key.setContentDescription("Pound");
        key.setOnClickListener(view -> {
            typed.append(digit);
            if (digits != null) digits.setText(typed);
            toneHandler.postDelayed(tones.play(id, digit), 200);
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(72), dp(72));
        params.leftMargin = params.rightMargin = dp(10);
        key.setLayoutParams(params);
        return key;
    }

    /** Another call, as a pill the owner taps to show it. The pill is 44dp inside a 48dp target. */
    private TextView chip(String other, String label) {
        TextView chip = line(15, Color.WHITE);
        chip.setText(label);
        chip.setMaxWidth(dp(260));
        chip.setPadding(dp(16), 0, dp(16), 0);
        chip.setBackground(new InsetDrawable(pressable(GradientDrawable.RECTANGLE, NEUTRAL, dp(22)), 0, dp(2), 0, dp(2)));
        chip.setContentDescription("Show call, " + label);
        chip.setClickable(true);
        chip.setFocusable(true);
        chip.setOnClickListener(view -> {
            selected = other;
            render();
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(WRAP, dp(48));
        params.leftMargin = params.rightMargin = dp(4);
        chip.setLayoutParams(params);
        return chip;
    }

    /** The control icons, drawn in a 24-unit box and scaled to the requested size. */
    private static final class Glyph extends Drawable {
        static final int PHONE = 0, HANG_UP = 1, MUTE = 2, KEYPAD = 3, SPEAKER = 4, HOLD = 5;
        private final int kind, size;
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint erase = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private final Path path = new Path();

        Glyph(int kind, int color, int size) {
            this.kind = kind;
            this.size = size;
            fill.setColor(color);
            stroke.setColor(color);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
            erase.setStyle(Paint.Style.STROKE);
            erase.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
        }

        @Override public int getIntrinsicWidth() { return size; }
        @Override public int getIntrinsicHeight() { return size; }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
        @Override public void setAlpha(int alpha) {
            fill.setAlpha(alpha);
            stroke.setAlpha(alpha);
            invalidateSelf();
        }
        @Override public void setColorFilter(ColorFilter filter) {
            fill.setColorFilter(filter);
            stroke.setColorFilter(filter);
            invalidateSelf();
        }

        @Override public void draw(Canvas canvas) {
            Rect bounds = getBounds();
            float scale = Math.min(bounds.width(), bounds.height()) / 24f;
            int saved = canvas.save();
            canvas.translate(bounds.exactCenterX() - 12 * scale, bounds.exactCenterY() - 12 * scale);
            canvas.scale(scale, scale);
            switch (kind) {
                case PHONE:
                    // The same handset, lifted: earpiece up and to the left.
                    canvas.rotate(-135, 12, 12);
                    handset(canvas);
                    break;
                case HANG_UP: handset(canvas); break;
                case MUTE: microphone(canvas); break;
                case KEYPAD:
                    for (float y = 4; y < 16; y += 5.5f) {
                        for (float x = 6; x < 19; x += 6) canvas.drawCircle(x, y, 1.6f, fill);
                    }
                    canvas.drawCircle(12, 20.5f, 1.6f, fill);
                    break;
                case SPEAKER: speaker(canvas); break;
                default:
                    canvas.drawRoundRect(6.5f, 5, 10.5f, 19, 1.2f, 1.2f, fill);
                    canvas.drawRoundRect(13.5f, 5, 17.5f, 19, 1.2f, 1.2f, fill);
            }
            canvas.restoreToCount(saved);
        }

        /** A handset lying face down: a bridge between an earpiece and a mouthpiece. */
        private void handset(Canvas canvas) {
            canvas.translate(0, -0.95f);
            stroke.setStrokeWidth(3.4f);
            stroke.setStrokeCap(Paint.Cap.BUTT);
            box.set(1, 10, 23, 32);
            canvas.drawArc(box, 215, 110, false, stroke);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            canvas.drawRoundRect(1.6f, 12.6f, 7.4f, 17.6f, 1.6f, 1.6f, fill);
            canvas.drawRoundRect(16.6f, 12.6f, 22.4f, 17.6f, 1.6f, 1.6f, fill);
        }

        /** A microphone struck through; the stroke is cut clear of the microphone on both sides. */
        private void microphone(Canvas canvas) {
            int layer = canvas.saveLayer(0, 0, 24, 24, null);
            canvas.drawRoundRect(9, 2.5f, 15, 13.5f, 3, 3, fill);
            stroke.setStrokeWidth(1.9f);
            box.set(6, 5.5f, 18, 17.5f);
            canvas.drawArc(box, 0, 180, false, stroke);
            canvas.drawLine(12, 17.5f, 12, 21, stroke);
            canvas.drawLine(9, 21, 15, 21, stroke);
            erase.setStrokeWidth(5);
            canvas.drawLine(4, 3.5f, 20, 20.5f, erase);
            canvas.drawLine(4, 3.5f, 20, 20.5f, stroke);
            canvas.restoreToCount(layer);
        }

        private void speaker(Canvas canvas) {
            canvas.translate(1.2f, 0);
            path.rewind();
            path.moveTo(2.5f, 9.5f);
            path.lineTo(6, 9.5f);
            path.lineTo(10.5f, 5.5f);
            path.lineTo(10.5f, 18.5f);
            path.lineTo(6, 14.5f);
            path.lineTo(2.5f, 14.5f);
            path.close();
            canvas.drawPath(path, fill);
            stroke.setStrokeWidth(1.9f);
            canvas.drawPath(path, stroke);
            box.set(6.5f, 7.5f, 15.5f, 16.5f);
            canvas.drawArc(box, -50, 100, false, stroke);
            box.set(3, 4, 19, 20);
            canvas.drawArc(box, -50, 100, false, stroke);
        }
    }

    public static String stateLabel(int state) {
        switch (state) {
            case Call.STATE_RINGING: return "Incoming call";
            case Call.STATE_DIALING: return "Dialing";
            case Call.STATE_CONNECTING: return "Connecting";
            case Call.STATE_ACTIVE: return "Connected";
            case Call.STATE_HOLDING: return "On hold";
            case Call.STATE_DISCONNECTING: return "Ending call";
            case Call.STATE_DISCONNECTED: return "Call ended";
            case Call.STATE_SELECT_PHONE_ACCOUNT: return "Choose a phone account";
            default: return "Preparing call";
        }
    }
}
