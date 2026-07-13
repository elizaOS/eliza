package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.xml.parsers.DocumentBuilderFactory;

/**
 * JVM-side contract for the launcher/QS intent surface — everything about the
 * tiles and static shortcuts that is checkable without a device: the manifest
 * declares all three assistant tile services bind-guarded with the QS_TILE
 * filter, shortcuts.xml carries the expected shortcut ids / MainActivity VIEW
 * intents / App Actions capability bindings, and every tile's deep-link URI
 * uses the android-qs-tile source the renderer's assistant-launch claim gate
 * trusts. Runs in the plain unit-test lane (testDebugUnitTest), so a manifest
 * or shortcut regression fails CI before any emulator is involved.
 */
public class LauncherIntentSurfaceTest {

    private static final String ANDROID_NS =
            "http://schemas.android.com/apk/res/android";
    private static final String QS_TILE_PERMISSION =
            "android.permission.BIND_QUICK_SETTINGS_TILE";
    private static final String QS_TILE_ACTION =
            "android.service.quicksettings.action.QS_TILE";

    // ── source-tree resolution ──────────────────────────────────────────────

    /**
     * AGP runs unit tests with the module directory as the working directory,
     * but IDE and repo-root runners differ — so probe the module-relative path
     * from the working directory and each ancestor.
     */
    private static File moduleRoot() {
        String[] candidates = {
            "", "app", "packages/app-core/platforms/android/app",
        };
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (dir != null) {
            for (String candidate : candidates) {
                File root = candidate.isEmpty() ? dir : new File(dir, candidate);
                if (new File(root, "src/main/AndroidManifest.xml").isFile()) {
                    return root;
                }
            }
            dir = dir.getParentFile();
        }
        throw new AssertionError(
                "Could not locate the android app module root from "
                        + System.getProperty("user.dir"));
    }

    private static Document parseXml(File file) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(file);
    }

    private static Document manifest() throws Exception {
        return parseXml(new File(moduleRoot(), "src/main/AndroidManifest.xml"));
    }

    private static Document shortcuts() throws Exception {
        return parseXml(new File(moduleRoot(), "src/main/res/xml/shortcuts.xml"));
    }

    private static List<Element> childElements(Element parent, String tag) {
        List<Element> result = new ArrayList<>();
        NodeList children = parent.getElementsByTagName(tag);
        for (int i = 0; i < children.getLength(); i += 1) {
            result.add((Element) children.item(i));
        }
        return result;
    }

    // ── Quick Settings tile declarations ────────────────────────────────────

    private static Element findService(Document doc, String name) {
        for (Element service : childElements(doc.getDocumentElement(), "service")) {
            if (name.equals(service.getAttributeNS(ANDROID_NS, "name"))) {
                return service;
            }
        }
        return null;
    }

    @Test
    public void manifestDeclaresAllThreeAssistantTiles() throws Exception {
        Document doc = manifest();
        for (String name : new String[] {
            "ai.elizaos.app.ElizaChatTileService",
            "ai.elizaos.app.ElizaVoiceTileService",
            "ai.elizaos.app.ElizaTranscribeTileService",
        }) {
            Element service = findService(doc, name);
            assertNotNull(name + " must be declared in the manifest", service);
            assertEquals(
                    name + " must be guarded by BIND_QUICK_SETTINGS_TILE",
                    QS_TILE_PERMISSION,
                    service.getAttributeNS(ANDROID_NS, "permission"));
            assertEquals(
                    name + " must be exported so SystemUI can bind it",
                    "true",
                    service.getAttributeNS(ANDROID_NS, "exported"));

            boolean hasQsAction = false;
            for (Element action : childElements(service, "action")) {
                if (QS_TILE_ACTION.equals(action.getAttributeNS(ANDROID_NS, "name"))) {
                    hasQsAction = true;
                }
            }
            assertTrue(
                    name + " must filter for " + QS_TILE_ACTION
                            + " or it never appears in the QS edit panel",
                    hasQsAction);
        }
    }

    // ── tile deep-link URIs ─────────────────────────────────────────────────

    @Test
    public void tileDeepLinksUseTheTrustedQsTileSource() {
        Map<String, String> expected = new HashMap<>();
        expected.put(ElizaChatTileService.DEEP_LINK_URI, "chat");
        expected.put(ElizaVoiceTileService.DEEP_LINK_URI, "voice");
        expected.put(ElizaTranscribeTileService.DEEP_LINK_URI, "transcribe");

        for (Map.Entry<String, String> entry : expected.entrySet()) {
            java.net.URI uri = java.net.URI.create(entry.getKey());
            assertEquals("elizaos", uri.getScheme());
            assertEquals(entry.getValue(), uri.getHost());
            // The claim gate drops capture launches from untrusted sources; the
            // source param is load-bearing, not analytics.
            assertEquals("source=android-qs-tile", uri.getQuery());
        }
    }

    // ── static shortcuts ────────────────────────────────────────────────────

    @Test
    public void shortcutsCarryTheAssistantIntentsWithTrustedSources()
            throws Exception {
        Document doc = shortcuts();
        Map<String, Element> byId = new HashMap<>();
        for (Element shortcut :
                childElements(doc.getDocumentElement(), "shortcut")) {
            byId.put(shortcut.getAttributeNS(ANDROID_NS, "shortcutId"), shortcut);
        }

        for (String id : new String[] {
            "eliza_app_action_chat",
            "eliza_app_action_voice",
            "eliza_app_action_transcribe",
        }) {
            assertTrue("missing static shortcut " + id, byId.containsKey(id));
        }

        Map<String, String> expectedData = new HashMap<>();
        expectedData.put(
                "eliza_app_action_chat",
                "elizaos://chat?source=android-static-shortcut");
        // voice/transcribe carry capture flags after routing, so their source
        // must be in the renderer's trusted set (android-app-actions).
        expectedData.put(
                "eliza_app_action_voice",
                "elizaos://voice?source=android-app-actions");
        expectedData.put(
                "eliza_app_action_transcribe",
                "elizaos://transcribe?source=android-app-actions");

        for (Map.Entry<String, String> entry : expectedData.entrySet()) {
            Element shortcut = byId.get(entry.getKey());
            List<Element> intents = childElements(shortcut, "intent");
            assertEquals(
                    entry.getKey() + " must declare exactly one intent",
                    1,
                    intents.size());
            Element intent = intents.get(0);
            assertEquals(
                    "android.intent.action.VIEW",
                    intent.getAttributeNS(ANDROID_NS, "action"));
            assertEquals(
                    "ai.elizaos.app.MainActivity",
                    intent.getAttributeNS(ANDROID_NS, "targetClass"));
            assertEquals(
                    entry.getKey() + " data URI",
                    entry.getValue(),
                    intent.getAttributeNS(ANDROID_NS, "data"));
        }
    }

    @Test
    public void everyShortcutIsAppActionsBindable() throws Exception {
        Document doc = shortcuts();
        for (Element shortcut :
                childElements(doc.getDocumentElement(), "shortcut")) {
            String id = shortcut.getAttributeNS(ANDROID_NS, "shortcutId");
            assertEquals(
                    id + " must bind an App Actions capability so Assistant can"
                            + " open it by feature name",
                    1,
                    childElements(shortcut, "capability-binding").size());
        }
    }
}
