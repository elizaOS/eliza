/**
 * Android half of the {@code GlassBridge} Capacitor plugin: renders a native
 * Material overlay panel behind anchored regions of the WebView — the Android
 * sibling of the iOS 26 {@code UIGlassEffect} bridge
 * ({@code packages/app-core/platforms/ios/App/App/GlassBridge.swift}). TS
 * half: {@code packages/ui/src/glass/native-bridge.ts}. The JS API (attach /
 * updateRect / detach / setGrouping / isAvailable) and the rect contract
 * (viewport-relative CSS px) are identical on both platforms, so web callers
 * never branch per OS.
 *
 * <p>Layering model mirrors iOS: the WebView composites its own pixels, so a
 * native material can never live INSIDE the DOM. The web layer reports a rect,
 * a panel View is inserted in the Capacitor container BELOW the WebView, and
 * the page keeps that region transparent so the native material shows
 * through. On first attach the WebView background is set transparent —
 * without that Android paints an opaque backing and the panel is invisible.
 *
 * <p>Android has no system glass material, so the panel is built from the
 * Material dynamic palette: a rounded neutral-surface gradient with a
 * hairline top edge, tinted by the dynamic color system on API 31+. That is
 * also why availability gates on API 31 (S): below it there is no dynamic
 * palette and callers should stay on the CSS tier. {@code interactive} (an
 * iOS touch-shimmer flag) has no Android equivalent and is accepted but
 * ignored; {@code setGrouping} is stored best-effort for parity, matching the
 * iOS contract.
 */
package ai.elizaos.app;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;

/** Native material regions behind the WebView; see the file header. */
@CapacitorPlugin(name = "GlassBridge")
public class GlassBridgePlugin extends Plugin {

    private static final long RECT_ANIMATION_MS = 150;
    // Untrusted-boundary rect bounds (CSS px): a dimension must be a finite
    // positive number and no coordinate may leave this envelope — far above
    // any real viewport, far below anything that could stress LayoutParams
    // or the animator with absurd math.
    private static final double MAX_RECT_COORD_CSS_PX = 100_000d;

    /** Attached panel views by caller id. Main-thread only. */
    private final Map<String, View> regions = new HashMap<>();
    private float groupingSpacing = 0f;
    private boolean webViewMadeTransparent = false;

    private static boolean glassSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", glassSupported());
        call.resolve(result);
    }

    @PluginMethod
    public void attachGlass(PluginCall call) {
        String id = call.getString("id");
        RectF rect = parseRect(call.getObject("rect"));
        if (id == null || rect == null) {
            call.reject("attachGlass requires id and a finite, positive rect{x,y,width,height}");
            return;
        }
        if (!glassSupported()) {
            JSObject result = new JSObject();
            result.put("attached", false);
            call.resolve(result);
            return;
        }
        double cornerRadius = call.getDouble("cornerRadius", 0.0);
        String tintColor = call.getString("tintColor");
        String colorScheme = call.getString("colorScheme", "system");

        Activity activity = getActivity();
        if (activity == null) {
            JSObject result = new JSObject();
            result.put("attached", false);
            call.resolve(result);
            return;
        }
        activity.runOnUiThread(() -> {
            WebView webView = bridge.getWebView();
            ViewGroup container =
                    webView != null ? (ViewGroup) webView.getParent() : null;
            if (webView == null || container == null) {
                JSObject result = new JSObject();
                result.put("attached", false);
                call.resolve(result);
                return;
            }
            makeWebViewTransparentOnce(webView);

            // Replace-on-reattach: same id moves/rebuilds the region.
            View previous = regions.remove(id);
            if (previous != null) {
                container.removeView(previous);
            }

            float density = webView.getResources().getDisplayMetrics().density;
            View panel = new View(activity);
            panel.setBackground(
                    buildMaterial(activity, colorScheme, tintColor,
                            (float) cornerRadius * density));
            panel.setClickable(false);
            panel.setFocusable(false);

            RectF px = toDevicePixels(rect, density);
            ViewGroup.LayoutParams params = new ViewGroup.LayoutParams(
                    Math.round(px.width()), Math.round(px.height()));
            panel.setLayoutParams(params);
            // Translation-based positioning keeps the panel parent-agnostic:
            // it works identically whether Capacitor's container is a
            // FrameLayout or a CoordinatorLayout.
            panel.setX(px.left + webView.getX());
            panel.setY(px.top + webView.getY());

            container.addView(panel, container.indexOfChild(webView));
            regions.put(id, panel);

            JSObject result = new JSObject();
            result.put("attached", true);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void updateRect(PluginCall call) {
        String id = call.getString("id");
        RectF rect = parseRect(call.getObject("rect"));
        if (id == null || rect == null) {
            call.reject("updateRect requires id and a finite, positive rect{x,y,width,height}");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            View panel = regions.get(id);
            WebView webView = bridge.getWebView();
            if (panel == null || webView == null) {
                call.resolve();
                return;
            }
            float density = webView.getResources().getDisplayMetrics().density;
            RectF px = toDevicePixels(rect, density);
            float targetX = px.left + webView.getX();
            float targetY = px.top + webView.getY();
            int targetW = Math.round(px.width());
            int targetH = Math.round(px.height());

            ViewGroup.LayoutParams params = panel.getLayoutParams();
            int startW = params.width;
            int startH = params.height;
            float startX = panel.getX();
            float startY = panel.getY();

            // One animator lerps position and size together — the Android
            // mirror of the iOS 0.15s UIView.animate frame change.
            ValueAnimator animator = ValueAnimator.ofFloat(0f, 1f);
            animator.setDuration(RECT_ANIMATION_MS);
            animator.addUpdateListener(animation -> {
                float t = (float) animation.getAnimatedValue();
                panel.setX(startX + (targetX - startX) * t);
                panel.setY(startY + (targetY - startY) * t);
                ViewGroup.LayoutParams lp = panel.getLayoutParams();
                lp.width = Math.round(startW + (targetW - startW) * t);
                lp.height = Math.round(startH + (targetH - startH) * t);
                panel.setLayoutParams(lp);
            });
            animator.start();
            call.resolve();
        });
    }

    @PluginMethod
    public void detachGlass(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("detachGlass requires id");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            View panel = regions.remove(id);
            if (panel != null && panel.getParent() instanceof ViewGroup) {
                ((ViewGroup) panel.getParent()).removeView(panel);
            }
            call.resolve();
        });
    }

    /**
     * Diagnostic readback for device e2e: reports whether {@code id} has a
     * live panel, the total region count, and the panel's REAL on-screen
     * geometry (device px, container coordinates) read from the View itself —
     * so tests prove insertion/replace/move/detach against native truth, not
     * just resolved promises.
     */
    @PluginMethod
    public void getRegionState(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("getRegionState requires id");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        activity.runOnUiThread(() -> {
            JSObject result = new JSObject();
            result.put("regionCount", regions.size());
            View panel = regions.get(id);
            boolean exists = panel != null && panel.getParent() != null;
            result.put("exists", exists);
            if (exists) {
                ViewGroup parent = (ViewGroup) panel.getParent();
                WebView webView = bridge.getWebView();
                result.put("attachedBelowWebView",
                        webView != null
                                && parent.indexOfChild(panel)
                                        < parent.indexOfChild(webView));
                JSObject rect = new JSObject();
                rect.put("x", (double) panel.getX());
                rect.put("y", (double) panel.getY());
                ViewGroup.LayoutParams lp = panel.getLayoutParams();
                rect.put("width", (double) lp.width);
                rect.put("height", (double) lp.height);
                result.put("rect", rect);
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setGrouping(PluginCall call) {
        // Stored for parity with iOS (UIGlassContainerEffect spacing); the
        // Android material has no grouping concept, so this is best-effort by
        // contract on both platforms.
        groupingSpacing = (float) (double) call.getDouble("spacing", 0.0);
        call.resolve();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    /**
     * The Android "glass": a rounded panel on the Material dynamic neutral
     * palette — near-opaque surface gradient with a hairline light edge —
     * optionally blended with a caller tint. Dark scheme by default; the
     * dynamic palette resources exist from API 31, which the availability
     * gate guarantees.
     */
    private GradientDrawable buildMaterial(
            Activity activity, String colorScheme, String tintColor,
            float cornerRadiusPx) {
        boolean light = "light".equals(colorScheme);
        int top;
        int bottom;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            top = activity.getColor(light
                    ? android.R.color.system_neutral1_50
                    : android.R.color.system_neutral1_900);
            bottom = activity.getColor(light
                    ? android.R.color.system_neutral1_100
                    : android.R.color.system_neutral1_1000);
        } else {
            top = light ? 0xFFF2F2F5 : 0xFF17181C;
            bottom = light ? 0xFFE8E8EC : 0xFF0E0F12;
        }
        // Slight translucency keeps the panel reading as a material sheet
        // instead of a solid card while staying legible over any backdrop.
        top = withAlpha(top, 0.96f);
        bottom = withAlpha(bottom, 0.99f);

        Integer tint = parseCssHexColor(tintColor);
        if (tint != null) {
            top = blend(top, tint);
            bottom = blend(bottom, tint);
        }

        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] { top, bottom });
        drawable.setCornerRadius(cornerRadiusPx);
        // Hairline edge: the light-catching rim that seats the sheet above
        // the backdrop, mirroring the iOS glass rim.
        drawable.setStroke(1, light ? 0x1A000000 : 0x1FFFFFFF);
        return drawable;
    }

    private void makeWebViewTransparentOnce(WebView webView) {
        if (webViewMadeTransparent) return;
        webViewMadeTransparent = true;
        webView.setBackgroundColor(Color.TRANSPARENT);
    }

    private static RectF toDevicePixels(RectF cssRect, float density) {
        return new RectF(
                cssRect.left * density,
                cssRect.top * density,
                cssRect.right * density,
                cssRect.bottom * density);
    }

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect
    // (missing/non-finite/non-positive/out-of-envelope values) produces an
    // explicit null → the method rejects; nothing is clamped into a
    // fake-valid region that would reach LayoutParams or the animator.
    private static RectF parseRect(JSObject object) {
        if (object == null) return null;
        double x = object.optDouble("x", Double.NaN);
        double y = object.optDouble("y", Double.NaN);
        double width = object.optDouble("width", Double.NaN);
        double height = object.optDouble("height", Double.NaN);
        if (!Double.isFinite(x) || !Double.isFinite(y)
                || !Double.isFinite(width) || !Double.isFinite(height)) {
            return null;
        }
        if (width <= 0 || height <= 0) return null;
        if (Math.abs(x) > MAX_RECT_COORD_CSS_PX
                || Math.abs(y) > MAX_RECT_COORD_CSS_PX
                || width > MAX_RECT_COORD_CSS_PX
                || height > MAX_RECT_COORD_CSS_PX) {
            return null;
        }
        return new RectF((float) x, (float) y,
                (float) (x + width), (float) (y + height));
    }

    private static int withAlpha(int color, float alpha) {
        int a = Math.round(255 * alpha);
        return (color & 0x00FFFFFF) | (a << 24);
    }

    /** Source-over blend of {@code overlay} (with its alpha) onto {@code base}. */
    private static int blend(int base, int overlay) {
        float alpha = Color.alpha(overlay) / 255f;
        int r = Math.round(Color.red(overlay) * alpha + Color.red(base) * (1 - alpha));
        int g = Math.round(Color.green(overlay) * alpha + Color.green(base) * (1 - alpha));
        int b = Math.round(Color.blue(overlay) * alpha + Color.blue(base) * (1 - alpha));
        return Color.argb(Color.alpha(base), r, g, b);
    }

    /**
     * Minimal CSS hex parser (#rgb, #rgba, #rrggbb, #rrggbbaa) — the same
     * grammar the iOS bridge accepts. CSS trailing-alpha order is converted
     * to Android's leading-alpha ARGB.
     */
    private static Integer parseCssHexColor(String css) {
        if (css == null) return null;
        String hex = css.trim();
        if (!hex.startsWith("#")) return null;
        hex = hex.substring(1);
        if (hex.length() == 3 || hex.length() == 4) {
            StringBuilder doubled = new StringBuilder();
            for (char c : hex.toCharArray()) {
                doubled.append(c).append(c);
            }
            hex = doubled.toString();
        }
        if (hex.length() != 6 && hex.length() != 8) return null;
        long value;
        try {
            value = Long.parseLong(hex, 16);
        } catch (NumberFormatException e) {
            return null;
        }
        if (hex.length() == 6) {
            return (int) (0xFF000000L | value);
        }
        long rgb = value >> 8;
        long alpha = value & 0xFF;
        return (int) ((alpha << 24) | rgb);
    }
}
