/**
 * The owned Android browser connects to a website only through a navigation that its protection
 * rules have seen. Chromium otherwise reaches an address early, before those rules run:
 *  - LoadingPredictor preconnects to a navigation's origin as soon as the navigation starts
 *    (PrepareForPageLoad adds the URL itself even with no prediction). It is gated by the
 *    "Preload pages" preference, so the profile's default becomes "No preloading". The person can
 *    still choose preloading in settings.
 *  - An external VIEW intent or a Custom Tab intent starts a DNS prefetch, a preconnect, an early
 *    navigation in a hidden tab, resource prefetches or a parallel request for its address, and a
 *    Custom Tabs session's mayLaunchUrl preconnects or loads a hidden tab. Each of these is
 *    stopped in WarmupManager and CustomTabsConnection.
 *  - A Custom Tabs warmup prepares a spare tab, which a later Custom Tab takes over. That tab is
 *    made before the helpers that report its navigations to extensions exist, so the protection
 *    extension never saw the refused warning redirect in it. No spare tab is made.
 * The Custom Tab or tab then navigates normally, so the protection rules decide before any
 * connection is made.
 */
export function applyNoEarlyConnection(edit, replaceOnce) {
  edit("chrome/browser/preloading/preloading_prefs.cc", (source) =>
    replaceOnce(
      source,
      "      prefs::kNetworkPredictionOptions,\n      static_cast<int>(NetworkPredictionOptions::kDefault),\n",
      "      prefs::kNetworkPredictionOptions,\n      // Eliza OS: no connection before the browser's protection rules see a navigation.\n      static_cast<int>(NetworkPredictionOptions::kDisabled),\n",
      "no preloading by default",
    ),
  );
  const warmup =
    "chrome/android/java/src/org/chromium/chrome/browser/WarmupManager.java";
  edit(warmup, (source) => {
    source = replaceOnce(
      source,
      '@NullMarked\npublic class WarmupManager {\n    private static final String TAG = "WarmupManager";\n',
      '@NullMarked\npublic class WarmupManager {\n    private static final String TAG = "WarmupManager";\n\n    /**\n     * Eliza OS: whether an address may be resolved, connected to or loaded before a navigation\n     * that the browser\'s protection rules see. Never in the owned browser.\n     */\n    public static boolean isEarlyConnectionAllowed() {\n        return false;\n    }\n',
      "early connection switch",
    );
    source = replaceOnce(
      source,
      '        try (TraceEvent e = TraceEvent.scoped("WarmupManager.maybePrefetchDnsForUrlInBackground")) {\n            ThreadUtils.assertOnUiThread();\n',
      '        try (TraceEvent e = TraceEvent.scoped("WarmupManager.maybePrefetchDnsForUrlInBackground")) {\n            ThreadUtils.assertOnUiThread();\n            if (!isEarlyConnectionAllowed()) return;\n',
      "no DNS prefetch for an intent's address",
    );
    source = replaceOnce(
      source,
      "    public void createRegularSpareTab(Profile profile, @Nullable WebContents webContents) {\n        ThreadUtils.assertOnUiThread();\n        assert !profile.isOffTheRecord();\n",
      "    public void createRegularSpareTab(Profile profile, @Nullable WebContents webContents) {\n        ThreadUtils.assertOnUiThread();\n        assert !profile.isOffTheRecord();\n        // A spare tab is made before the tab helpers that report its navigations exist.\n        if (!isEarlyConnectionAllowed()) return;\n",
      "no spare tab",
    );
    return replaceOnce(
      source,
      '        try (TraceEvent e = TraceEvent.scoped("WarmupManager.maybePreconnectUrlAndSubResources")) {\n            ThreadUtils.assertOnUiThread();\n',
      '        try (TraceEvent e = TraceEvent.scoped("WarmupManager.maybePreconnectUrlAndSubResources")) {\n            ThreadUtils.assertOnUiThread();\n            if (!isEarlyConnectionAllowed()) return;\n',
      "no preconnect for an intent or session address",
    );
  });
  edit(
    "chrome/android/java/src/org/chromium/chrome/browser/customtabs/CustomTabsConnection.java",
    (source) => {
      source = replaceOnce(
        source,
        "    public boolean startEarlyNavigationInHiddenTab(Profile profile, Intent intent) {\n        return mHiddenTabHolder.startEarlynavigation(profile, intent);\n",
        "    public boolean startEarlyNavigationInHiddenTab(Profile profile, Intent intent) {\n        if (!WarmupManager.isEarlyConnectionAllowed()) return false;\n        return mHiddenTabHolder.startEarlynavigation(profile, intent);\n",
        "no early navigation in a hidden tab",
      );
      source = replaceOnce(
        source,
        "            @Nullable Bundle extras,\n            boolean useSeparateStoragePartitionForExperiment) {\n        ThreadUtils.assertOnUiThread();\n\n        WebContents webContents = null;\n",
        "            @Nullable Bundle extras,\n            boolean useSeparateStoragePartitionForExperiment) {\n        ThreadUtils.assertOnUiThread();\n        if (!WarmupManager.isEarlyConnectionAllowed()) return;\n\n        WebContents webContents = null;\n",
        "no mayLaunchUrl hidden tab",
      );
      source = replaceOnce(
        source,
        "    int maybePrefetchResources(@Nullable SessionHolder session, Intent intent) {\n        ThreadUtils.assertOnUiThread();\n",
        "    int maybePrefetchResources(@Nullable SessionHolder session, Intent intent) {\n        ThreadUtils.assertOnUiThread();\n        if (!WarmupManager.isEarlyConnectionAllowed()) return 0;\n",
        "no Custom Tab resource prefetch",
      );
      return replaceOnce(
        source,
        "            @Nullable SessionHolder session, Intent intent) {\n        ThreadUtils.assertOnUiThread();\n\n        if (!intent.hasExtra(PARALLEL_REQUEST_URL_KEY)\n",
        "            @Nullable SessionHolder session, Intent intent) {\n        ThreadUtils.assertOnUiThread();\n        if (!WarmupManager.isEarlyConnectionAllowed()) return ParallelRequestStatus.NO_REQUEST;\n\n        if (!intent.hasExtra(PARALLEL_REQUEST_URL_KEY)\n",
        "no Custom Tab parallel request",
      );
    },
  );
}
