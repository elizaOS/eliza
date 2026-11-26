package ai.eliza.plugins.browsersurface;

import static org.junit.Assert.*;

import android.content.Intent;
import java.util.Set;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Actual Android intent construction. No handler is launched and no call or message is sent. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class BrowserExternalHandoffTest {
  private static final String OWNER = "example.owner";
  private static final Set<String> ROUTES = Set.of("owner");
  private static final BrowserTabHostConfig HOST = config(false);
  private static final BrowserTabHostConfig APP_HOST = config(true);
  private static final String[] APP_LINKS = {"whatsapp://send?text=Review", "zoommtg://zoom.us/join?confno=1",
      "tg://resolve?domain=review", "msteams:/l/meetup-join/review", "spotify:track:review", "slack://open"};
  private static BrowserTabHostConfig config(boolean appLinks) {
    return BrowserTabHostConfig.builder("review", "review_private_", "review").hostScheme("owner").appLinks(appLinks)
        .autofillExtras(new BrowserAutofillExtras("review.field", "review.top")).build();
  }
  @Test public void tappedSystemLinksOnlyOpenTheirFixedReviewAction() {
    String[][] links = {{"tel:+15555550100", Intent.ACTION_DIAL},
        {"sms:+15555550100?body=Review%20me", Intent.ACTION_SENDTO},
        {"smsto:+15555550100", Intent.ACTION_SENDTO},
        {"mailto:review@example.invalid", Intent.ACTION_SENDTO},
        {"geo:0,0?q=Review%20place", Intent.ACTION_VIEW}};
    for (String[] link : links) {
      assertTrue(BrowserExternalLinkPolicy.systemLink(link[0]));
      assertEquals(BrowserExternalLinkPolicy.Handoff.REFUSE,
          BrowserExternalLinkPolicy.decide(link[0], false, null, null, null, OWNER, ROUTES));
      Intent intent = BrowserExternalHandoff.intentFor(link[0], OWNER, HOST);
      assertNotNull(intent);
      assertEquals(link[1], intent.getAction());
      assertEquals(link[0], intent.getDataString());
      assertNull(intent.getComponent()); assertNull(intent.getSelector());
      assertNull(intent.getPackage()); assertNull(intent.getExtras());
      assertNull(intent.getClipData()); assertEquals(0, intent.getFlags());
    }
  }
  @Test public void intentLinksCannotSupplyPrivateRoutesOrEffectAuthority() {
    assertNull(BrowserExternalHandoff.intentFor("intent://call/#Intent;scheme=tel;action=android.intent.action.CALL;end", OWNER, HOST));
    assertNull(BrowserExternalHandoff.intentFor("intent://private/#Intent;scheme=owner;end", OWNER, HOST));
    assertNull(BrowserExternalHandoff.intentFor("intent://private/#Intent;scheme=https;package=example.owner;end", OWNER, HOST));
    Intent intent = BrowserExternalHandoff.intentFor("intent://review/#Intent;scheme=https;component=example.other/.Private;launchFlags=0x3;S.untrusted=discard;end", OWNER, HOST);
    assertNotNull(intent); assertEquals(Intent.ACTION_VIEW, intent.getAction());
    assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE));
    assertNull(intent.getComponent()); assertNull(intent.getSelector());
    assertNull(intent.getExtras()); assertNull(intent.getClipData()); assertEquals(0, intent.getFlags());
    assertFalse(BrowserExternalLinkPolicy.systemLink("intent://review/#Intent;scheme=tel;end"));
    assertFalse(BrowserExternalLinkPolicy.systemLink("market://details?id=example.owner"));
  }
  @Test public void malformedAndControlBearingLinksNeverCreateAnIntent() {
    for (String raw : new String[] {"sms:123\n456", "geo:0,0\u0000", "tel:" + "1".repeat(4096), "content://private/item", "owner://private"})
      assertNull(BrowserExternalHandoff.intentFor(raw, OWNER, HOST));
  }
  private static final class Host extends BrowserTabHostPlugin {
    final androidx.appcompat.app.AppCompatActivity activity = org.robolectric.Robolectric.buildActivity(androidx.appcompat.app.AppCompatActivity.class).get();
    final java.util.List<String> notices = new java.util.ArrayList<>();
    @Override public android.content.Context getContext() { return activity; }
    @Override public androidx.appcompat.app.AppCompatActivity getActivity() { return activity; }
    final BrowserTabHostConfig config;
    Host() { this(HOST); }
    Host(BrowserTabHostConfig config) { this.config = config; }
    @Override protected BrowserTabHostConfig tabHostConfig() { return config; }
    @Override protected BrowserBookmarkStore openBookmarkStore(android.content.Context context) { throw new AssertionError("Handoff opens no bookmark store"); }
    @Override protected BrowserSessionStore openSessionStore(android.content.Context context) { throw new AssertionError("Handoff opens no session store"); }
    @Override protected void notifyListeners(String event, com.getcapacitor.JSObject value) {
      if ("notice".equals(event) && value != null) {
        String message = value.getString("message");
        if (message != null && !message.isEmpty()) notices.add(message);
      }
    }
  }
  private static Object tab(Host host) throws Exception {
    Class<?> type = Class.forName(BrowserTabHostPlugin.class.getName() + "$Tab");
    java.lang.reflect.Constructor<?> constructor = type.getDeclaredConstructor(); constructor.setAccessible(true);
    Object tab = constructor.newInstance();
    org.robolectric.util.ReflectionHelpers.setField(tab, "id", "selected");
    org.robolectric.util.ReflectionHelpers.setField(tab, "web", new android.webkit.WebView(host.activity));
    java.util.Map<String, Object> tabs = org.robolectric.util.ReflectionHelpers.getField(host, "tabs");
    tabs.put("selected", tab); org.robolectric.util.ReflectionHelpers.setField(host, "presentedId", "selected"); return tab;
  }
  private static void handoff(Host host, Object tab, String uri, boolean gesture) throws Exception {
    java.lang.reflect.Method method = BrowserTabHostPlugin.class.getDeclaredMethod("handoff", tab.getClass(), String.class, boolean.class);
    method.setAccessible(true); method.invoke(host, tab, uri, gesture);
  }
  @Test public void selectedTappedSystemLinkCanResolveToTheHostWithoutSending() throws Exception {
    Host host = new Host(); Object tab = tab(host);
    try {
      for (String raw : new String[] {"tel:+15555550100", "smsto:+15555550100", "geo:0,0?q=Review"}) {
        Intent expected = BrowserExternalHandoff.intentFor(raw, host.activity.getPackageName(), HOST);
        android.content.pm.ResolveInfo own = new android.content.pm.ResolveInfo(); own.activityInfo = new android.content.pm.ActivityInfo(); own.activityInfo.packageName = host.activity.getPackageName(); own.activityInfo.name = "ReviewTarget";
        org.robolectric.Shadows.shadowOf(host.activity.getPackageManager()).addResolveInfoForIntent(expected, own);
        handoff(host, tab, raw, true);
        Intent opened = org.robolectric.Shadows.shadowOf(host.activity).getNextStartedActivity();
        assertNotNull(opened); assertEquals(expected.getAction(), opened.getAction()); assertEquals(raw, opened.getDataString());
        assertNull(org.robolectric.Shadows.shadowOf(host.activity).getNextStartedActivity());
      }
    } finally { ((android.webkit.WebView) org.robolectric.util.ReflectionHelpers.getField(tab, "web")).destroy(); }
  }
  @Test public void retiredBackgroundUnselectedAndUntappedTabsCannotHandoff() throws Exception {
    for (String refusal : new String[] {"paused", "destroyed", "dead", "unselected", "replaced", "no-tap"}) {
      Host host = new Host(); Object tab = tab(host);
      try {
        if (refusal.equals("paused") || refusal.equals("destroyed")) org.robolectric.util.ReflectionHelpers.setField(host, refusal, true);
        if (refusal.equals("dead")) org.robolectric.util.ReflectionHelpers.setField(tab, "dead", true);
        if (refusal.equals("unselected")) org.robolectric.util.ReflectionHelpers.setField(host, "presentedId", "another");
        if (refusal.equals("replaced")) ((java.util.Map<?, ?>) org.robolectric.util.ReflectionHelpers.getField(host, "tabs")).clear();
        handoff(host, tab, "smsto:+15555550100", !refusal.equals("no-tap"));
        assertNull(refusal, org.robolectric.Shadows.shadowOf(host.activity).getNextStartedActivity());
      } finally { ((android.webkit.WebView) org.robolectric.util.ReflectionHelpers.getField(tab, "web")).destroy(); }
    }
  }
  @Test public void appLinksOpenAsAFreshBrowsableViewOnlyForAHostThatTakesThem() {
    for (String raw : APP_LINKS) {
      assertTrue(raw, BrowserExternalLinkPolicy.appLink(raw, ROUTES));
      assertFalse(raw, BrowserExternalHandoff.external(raw, HOST));
      assertNull(raw, BrowserExternalHandoff.intentFor(raw, OWNER, HOST));
      assertTrue(raw, BrowserExternalHandoff.external(raw, APP_HOST));
      Intent intent = BrowserExternalHandoff.intentFor(raw, OWNER, APP_HOST);
      assertNotNull(raw, intent);
      assertEquals(Intent.ACTION_VIEW, intent.getAction()); assertEquals(raw, intent.getDataString());
      assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE)); assertEquals(1, intent.getCategories().size());
      assertNull(intent.getComponent()); assertNull(intent.getSelector());
      assertNull(intent.getPackage()); assertNull(intent.getExtras());
      assertNull(intent.getClipData()); assertEquals(0, intent.getFlags());
    }
  }
  @Test public void appLinksNeverCarryWebBrowserHostOrMalformedSchemes() {
    for (String raw : new String[] {"http://example.invalid/", "https://example.invalid/", "about:blank",
        "blob:https://example.invalid/id", "data:text/html,review", "file:///sdcard/review", "content://private/item",
        "javascript:alert(1)", "JavaScript:alert(1)", "filesystem:https://example.invalid/temporary/review",
        "ws://example.invalid/", "wss://example.invalid/", "chrome://settings", "android-app://example.other/https/review",
        "intent:#Intent;end", "market://details?id=example.other", "owner://private", "OWNER://private",
        "1review:open", "-review:open", "re view:open", ":open", "review", "", "whatsapp://send?text=a\nb",
        "whatsapp://send?text=" + "a".repeat(4096)}) {
      assertFalse(raw, BrowserExternalLinkPolicy.appLink(raw, ROUTES));
      Intent intent = BrowserExternalHandoff.intentFor(raw, OWNER, APP_HOST);
      if (BrowserExternalHandoff.external(raw, APP_HOST))
        assertTrue(raw, BrowserExternalLinkPolicy.external(raw));
      else assertNull(raw, intent);
    }
    assertNull(BrowserExternalHandoff.intentFor("intent://private/#Intent;scheme=owner;end", OWNER, APP_HOST));
    assertNull(BrowserExternalHandoff.intentFor("intent://review/#Intent;scheme=javascript;end", OWNER, APP_HOST));
    assertEquals(Intent.ACTION_DIAL, BrowserExternalHandoff.intentFor("tel:+15555550100", OWNER, APP_HOST).getAction());
  }
  @Test public void tappedAppLinkOpensAnotherAppButNeverThisHostOrWithoutATap() throws Exception {
    String raw = "whatsapp://send?text=Review";
    for (String route : new String[] {"other", "own", "untapped", "not-taken"}) {
      Host host = new Host(route.equals("not-taken") ? HOST : APP_HOST); Object tab = tab(host);
      try {
        if (route.equals("own")) {
          android.content.pm.ResolveInfo own = new android.content.pm.ResolveInfo(); own.activityInfo = new android.content.pm.ActivityInfo(); own.activityInfo.packageName = host.activity.getPackageName(); own.activityInfo.name = "ReviewTarget";
          org.robolectric.Shadows.shadowOf(host.activity.getPackageManager()).addResolveInfoForIntent(BrowserExternalHandoff.intentFor(raw, host.activity.getPackageName(), APP_HOST), own);
        }
        handoff(host, tab, raw, !route.equals("untapped"));
        Intent opened = org.robolectric.Shadows.shadowOf(host.activity).getNextStartedActivity();
        if (route.equals("other")) {
          assertNotNull(opened); assertEquals(Intent.ACTION_VIEW, opened.getAction()); assertEquals(raw, opened.getDataString());
          assertNull(opened.getComponent()); assertNull(opened.getPackage()); assertEquals(0, opened.getFlags());
        } else assertNull(route, opened);
      } finally { ((android.webkit.WebView) org.robolectric.util.ReflectionHelpers.getField(tab, "web")).destroy(); }
    }
  }
  @Test public void untappedAppLinkStaysSilentOnLivePageWhileSystemOrBlankStillNotifies() throws Exception {
    String blocked = "Blocked a link to another app that opened without a tap.";
    String appLink = "whatsapp://send?text=Review";
    for (String mode : new String[] {"committed-app", "started-app", "blank-app", "errored-app", "committed-sms", "committed-intent"}) {
      Host host = new Host(APP_HOST); Object tab = tab(host);
      try {
        if (mode.startsWith("committed-") || mode.equals("errored-app"))
          org.robolectric.util.ReflectionHelpers.setField(tab, "committed", true);
        if (mode.equals("started-app"))
          org.robolectric.util.ReflectionHelpers.setField(tab, "documentStarted", true);
        if (mode.equals("errored-app"))
          org.robolectric.util.ReflectionHelpers.setField(tab, "error", "Page could not load.");
        String uri = mode.equals("committed-sms") ? "smsto:+15555550100"
            : mode.equals("committed-intent") ? "intent://review/#Intent;scheme=https;end" : appLink;
        handoff(host, tab, uri, false);
        assertNull(mode, org.robolectric.Shadows.shadowOf(host.activity).getNextStartedActivity());
        if (mode.equals("committed-app") || mode.equals("started-app")) {
          assertEquals(mode, java.util.List.of(), host.notices);
        } else {
          assertEquals(mode, java.util.List.of(blocked), host.notices);
        }
      } finally { ((android.webkit.WebView) org.robolectric.util.ReflectionHelpers.getField(tab, "web")).destroy(); }
    }
  }
}
