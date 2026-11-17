package ai.eliza.plugins.passwords;

import android.app.Activity;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.net.URI;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Minimal native sheet used by the fill picker and save prompt. Hosts may restyle via theme. */
final class PasswordSheet {
  static final ExecutorService IO = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "eliza-passwords"); thread.setDaemon(true); return thread;
  });
  final LinearLayout root, list;
  final TextView title, subtitle, status;

  PasswordSheet(Activity activity) {
    // Never captured by screenshots, screen recording or the recents thumbnail.
    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
    int pad = dp(activity, 20);
    root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(pad, pad, pad, dp(activity, 12));
    title = text(activity, 20, true); subtitle = text(activity, 14, false); status = text(activity, 14, false);
    list = new LinearLayout(activity); list.setOrientation(LinearLayout.VERTICAL);
    ScrollView scroll = new ScrollView(activity); scroll.addView(list);
    root.addView(title); root.addView(subtitle); root.addView(status); root.addView(scroll, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
    activity.setContentView(root);
  }

  Button button(Activity activity, CharSequence label, View.OnClickListener click) {
    Button button = new Button(activity); button.setText(label); button.setAllCaps(false); button.setOnClickListener(click);
    button.setMinHeight(dp(activity, 48)); button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
    return button;
  }

  static TextView text(Context context, int sp, boolean bold) {
    TextView view = new TextView(context); view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
    android.content.res.TypedArray appearance = context.obtainStyledAttributes(new int[]{android.R.attr.textColorPrimary});
    try { android.content.res.ColorStateList color = appearance.getColorStateList(0); if (color != null) view.setTextColor(color); }
    finally { appearance.recycle(); }
    if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
    view.setPadding(0, 0, 0, dp(context, 8)); return view;
  }

  static int dp(Context context, int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

  /** Human-readable subject: host for websites, app label (or package) for apps. Never a secret. */
  static String subject(Context context, PasswordFormPolicy.Target target) {
    if (target.web()) {
      try { return new URI(target.webOrigin).getHost(); } catch (Exception invalid) { return target.webOrigin; }
    }
    return appLabel(context, target.appPackage);
  }

  static String bindingLabel(Context context, String facet) {
    if (PasswordFacets.isAndroid(facet)) return appLabel(context, PasswordFacets.androidPackage(facet));
    try { return new URI(facet).getHost(); } catch (Exception invalid) { return facet; }
  }

  static String appLabel(Context context, String packageName) {
    try {
      PackageManager manager = context.getPackageManager();
      ApplicationInfo info = manager.getApplicationInfo(packageName, 0);
      CharSequence label = manager.getApplicationLabel(info);
      return label == null || label.length() == 0 ? packageName : label + " (" + packageName + ")";
    } catch (Exception unavailable) { return packageName; }
  }
}
