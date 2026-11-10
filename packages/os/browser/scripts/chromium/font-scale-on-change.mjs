/**
 * Android's font size reaches web pages through the profile's `font_scale_factor` web
 * preference (FontSizePrefs), which drives text autosizing, pages that opt in with
 * `<meta name="text-scale">` and `env(preferred-text-scale)`. Chromium sets it only when a
 * foreground session starts, from the application's configuration. A size changed while the
 * browser stays open is therefore applied only when the activity's own relaunch happens to end
 * and restart the session after the application configuration already has the new size. A
 * Custom Tab embedded beside another app often relaunches first, so its pages, and every page
 * opened until the browser was closed, kept the old size.
 *
 * The session tracker now also sets the preference when the application's font scale changes
 * during a session, for each profile the session started. The value still comes from the
 * application configuration, which Android has updated before it calls these callbacks.
 */
export function applyFontScaleOnChange(edit, replaceOnce) {
  edit(
    "chrome/android/java/src/org/chromium/chrome/browser/ChromeActivitySessionTracker.java",
    (source) => {
      source = replaceOnce(
        source,
        "import android.annotation.SuppressLint;\nimport android.text.TextUtils;\n",
        "import android.annotation.SuppressLint;\nimport android.content.ComponentCallbacks;\nimport android.content.res.Configuration;\nimport android.text.TextUtils;\n",
        "configuration callback imports",
      );
      source = replaceOnce(
        source,
        "import org.chromium.base.Callback;\nimport org.chromium.base.LocaleUtils;\n",
        "import org.chromium.base.Callback;\nimport org.chromium.base.ContextUtils;\nimport org.chromium.base.LocaleUtils;\n",
        "application context import",
      );
      source = replaceOnce(
        source,
        "        mVariationsSession.initializeWithNative();\n        ApplicationStatus.registerApplicationStateListener(createApplicationStateListener());\n    }\n",
        `        mVariationsSession.initializeWithNative();
        ApplicationStatus.registerApplicationStateListener(createApplicationStateListener());
        // Eliza OS: follow a font size change while the browser stays open, not only at the
        // next foreground session.
        ContextUtils.getApplicationContext()
                .registerComponentCallbacks(
                        new ComponentCallbacks() {
                            private float mFontScale =
                                    ContextUtils.getApplicationContext()
                                            .getResources()
                                            .getConfiguration()
                                            .fontScale;

                            @Override
                            public void onConfigurationChanged(Configuration configuration) {
                                if (configuration.fontScale == mFontScale) return;
                                mFontScale = configuration.fontScale;
                                onFontScaleChanged();
                            }

                            @Override
                            public void onLowMemory() {}
                        });
    }

    /**
     * Eliza OS: sets the font scale factor of each profile this foreground session started, so
     * open pages and the next ones follow Android's new font size. Outside a session, the next
     * session start sets it.
     */
    private void onFontScaleChanged() {
        ThreadUtils.assertOnUiThread();
        if (!mIsStarted) return;
        for (Profile profile : mStartupProfileTasksCompleted.getTrackedProfiles()) {
            FontSizePrefs.getInstance(profile).setFontScaleFactor();
        }
    }
`,
        "font size followed during a session",
      );
      return source;
    },
  );
}
