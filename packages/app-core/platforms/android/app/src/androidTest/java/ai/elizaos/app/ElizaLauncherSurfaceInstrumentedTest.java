package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;
import android.content.res.XmlResourceParser;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.xmlpull.v1.XmlPullParser;

/**
 * Retail-path assertions that Eliza's launcher/QS entry surfaces survived
 * install-time parsing on ANY debug build: the three assistant Quick Settings
 * tiles (chat / voice / transcribe) are declared, bind-guarded, and resolvable
 * for the QS_TILE action, and the static shortcuts resource compiles into the
 * APK with the expected shortcut ids and elizaos:// data URIs.
 *
 * Complements ElizaAssistantSurfaceInstrumentedTest (assistant / IME / voice
 * declarations): this covers the surfaces a user reaches from the QS edit
 * panel and launcher long-press. The data-URI assertions are load-bearing —
 * the renderer's assistant-launch claim gate drops capture launches
 * (voice=1 / transcribe=1) whose source is not in its trusted set, so a
 * regressed source here means a tile/shortcut that opens the app but never
 * starts capture.
 */
@RunWith(AndroidJUnit4.class)
public class ElizaLauncherSurfaceInstrumentedTest {

    private static final String PACKAGE_NAME = "ai.elizaos.app";
    private static final String ANDROID_NS =
            "http://schemas.android.com/apk/res/android";
    private static final String QS_TILE_PERMISSION =
            "android.permission.BIND_QUICK_SETTINGS_TILE";
    private static final String QS_TILE_ACTION =
            "android.service.quicksettings.action.QS_TILE";

    private static final String[] TILE_SERVICES = {
        "ai.elizaos.app.ElizaChatTileService",
        "ai.elizaos.app.ElizaVoiceTileService",
        "ai.elizaos.app.ElizaTranscribeTileService",
    };

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private ServiceInfo declaredService(String className) throws Exception {
        ComponentName component = new ComponentName(PACKAGE_NAME, className);
        return context().getPackageManager()
                .getServiceInfo(component, PackageManager.GET_META_DATA);
    }

    @Test
    public void allThreeAssistantTilesAreDeclaredAndBindGuarded() throws Exception {
        for (String className : TILE_SERVICES) {
            ServiceInfo info = declaredService(className);
            assertNotNull(className + " must be declared", info);
            assertTrue(
                    className + " must be exported so SystemUI can bind it",
                    info.exported);
            assertEquals(
                    className + " must be guarded by BIND_QUICK_SETTINGS_TILE",
                    QS_TILE_PERMISSION,
                    info.permission);
        }
    }

    @Test
    public void allThreeAssistantTilesResolveForTheQsTileAction() {
        Intent qsTile = new Intent(QS_TILE_ACTION);
        qsTile.setPackage(PACKAGE_NAME);
        List<ResolveInfo> resolved = context().getPackageManager()
                .queryIntentServices(qsTile, 0);
        for (String className : TILE_SERVICES) {
            boolean present = false;
            for (ResolveInfo candidate : resolved) {
                if (candidate.serviceInfo != null
                        && className.equals(candidate.serviceInfo.name)) {
                    present = true;
                    break;
                }
            }
            assertTrue(
                    className + " must resolve for " + QS_TILE_ACTION
                            + " or it never appears in the QS edit panel",
                    present);
        }
    }

    /**
     * Walks the compiled shortcuts.xml out of the installed APK's resources and
     * collects shortcutId → first intent data URI. Exercising the compiled
     * resource (not the source file) proves aapt accepted every attribute and
     * the launcher will see exactly these ids and URIs.
     */
    private Map<String, String> installedShortcutDataUris() throws Exception {
        int resId = context().getResources()
                .getIdentifier("shortcuts", "xml", PACKAGE_NAME);
        assertTrue("shortcuts.xml must compile into the APK", resId != 0);

        Map<String, String> shortcuts = new HashMap<>();
        try (XmlResourceParser parser = context().getResources().getXml(resId)) {
            String currentShortcutId = null;
            int event = parser.getEventType();
            while (event != XmlPullParser.END_DOCUMENT) {
                if (event == XmlPullParser.START_TAG) {
                    if ("shortcut".equals(parser.getName())) {
                        currentShortcutId =
                                parser.getAttributeValue(ANDROID_NS, "shortcutId");
                    } else if ("intent".equals(parser.getName())
                            && currentShortcutId != null
                            && !shortcuts.containsKey(currentShortcutId)) {
                        String data = parser.getAttributeValue(ANDROID_NS, "data");
                        if (data != null) {
                            shortcuts.put(currentShortcutId, data);
                        }
                    }
                } else if (event == XmlPullParser.END_TAG
                        && "shortcut".equals(parser.getName())) {
                    currentShortcutId = null;
                }
                event = parser.next();
            }
        }
        return shortcuts;
    }

    @Test
    public void staticShortcutsCarryTheAssistantIntentsWithTrustedSources()
            throws Exception {
        Map<String, String> shortcuts = installedShortcutDataUris();

        assertTrue(
                "chat shortcut missing from compiled shortcuts.xml: " + shortcuts,
                shortcuts.containsKey("eliza_app_action_chat"));
        assertEquals(
                "elizaos://chat?source=android-static-shortcut",
                shortcuts.get("eliza_app_action_chat"));

        // Capture intents: the renderer claim gate requires a trusted source or
        // voice/transcribe never starts (the app opens and nothing happens).
        assertEquals(
                "elizaos://voice?source=android-app-actions",
                shortcuts.get("eliza_app_action_voice"));
        assertEquals(
                "elizaos://transcribe?source=android-app-actions",
                shortcuts.get("eliza_app_action_transcribe"));
    }
}
