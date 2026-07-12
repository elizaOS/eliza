/**
 * Golden-fixture conformance test for the Android native-transcript decoder
 * and action-string formatters (contract:
 * packages/ui/src/chat/native-transcript/spec.ts; fixture:
 * packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json).
 * Pure JVM — no Robolectric, no android.* imports.
 *
 * Fixture path resolution: `ELIZA_TRANSCRIPT_FIXTURE` env var wins; otherwise
 * the test walks up from the working directory until it finds the repo's
 * `packages/ui/...` fixture, so it passes from the android module dir, the
 * repo root, or Gradle's per-module test cwd.
 *
 * Runs two ways:
 *  1. JUnit (Gradle `testDebugUnitTest`) — NOTE: requires a real org.json on
 *     the test classpath; AGP's mockable android.jar stubs org.json, and
 *     this lane may not edit build.gradle to add `org.json:json` as a
 *     testImplementation. Until that dependency lands, use path 2.
 *  2. Plain `java` main-class check (what CI/agents actually run):
 *       cd packages/app-core/platforms/android
 *       javac -cp json.jar:junit.jar -d /tmp/out \
 *         app/src/main/java/ai/elizaos/app/transcript/TranscriptModels.java \
 *         app/src/main/java/ai/elizaos/app/transcript/TranscriptActions.java \
 *         app/src/test/java/ai/elizaos/app/transcript/TranscriptContractTest.java
 *       java -cp /tmp/out:json.jar:junit.jar \
 *         ai.elizaos.app.transcript.TranscriptContractTest
 *     (json.jar = org.json:json:20240303; junit.jar = junit:junit:4.13.2.)
 */
package ai.elizaos.app.transcript;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;

import org.json.JSONObject;
import org.junit.Test;

public class TranscriptContractTest {

    private static final String FIXTURE_RELATIVE =
            "packages/ui/src/chat/native-transcript/__fixtures__/"
                    + "transcript-golden.json";

    private static File resolveFixture() {
        String override = System.getenv("ELIZA_TRANSCRIPT_FIXTURE");
        if (override != null && !override.isEmpty()) {
            File file = new File(override);
            if (file.isFile()) return file;
            throw new IllegalStateException(
                    "ELIZA_TRANSCRIPT_FIXTURE does not exist: " + override);
        }
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (dir != null) {
            File candidate = new File(dir, FIXTURE_RELATIVE);
            if (candidate.isFile()) return candidate;
            dir = dir.getParentFile();
        }
        throw new IllegalStateException("golden fixture not found above "
                + System.getProperty("user.dir") + " — set"
                + " ELIZA_TRANSCRIPT_FIXTURE");
    }

    private static TranscriptModels.Frame loadGoldenFrame() throws Exception {
        String json = new String(
                Files.readAllBytes(resolveFixture().toPath()),
                StandardCharsets.UTF_8);
        return TranscriptModels.decodeFrame(new JSONObject(json));
    }

    // ── Frame + segment-kind histogram ──────────────────────────────────

    @Test
    public void decodesGoldenFrameShape() throws Exception {
        TranscriptModels.Frame frame = loadGoldenFrame();
        assertEquals(TranscriptModels.SCHEMA, frame.schema);
        assertEquals(26, frame.messages.size());
        assertNull(frame.turnStatus);

        int users = 0;
        int assistants = 0;
        for (TranscriptModels.Message message : frame.messages) {
            if (message.isUser()) users++;
            else assistants++;
        }
        assertEquals(12, users);
        assertEquals(14, assistants);
    }

    @Test
    public void segmentKindHistogramMatchesGolden() throws Exception {
        Map<String, Integer> histogram =
                segmentHistogram(loadGoldenFrame());
        Map<String, Integer> expected = new TreeMap<>();
        expected.put("text", 26);
        expected.put("widget", 7);
        expected.put("permission", 1);
        expected.put("code", 1);
        expected.put("ui-spec", 1);
        assertEquals(expected, histogram);
    }

    @Test
    public void widgetKindHistogramCoversAllSevenKinds() throws Exception {
        Map<String, Integer> histogram = widgetHistogram(loadGoldenFrame());
        Map<String, Integer> expected = new TreeMap<>();
        for (String kind : new String[] {"choice", "followups", "form",
                "workflow", "checklist", "task", "background"}) {
            expected.put(kind, 1);
        }
        assertEquals(expected, histogram);
        // Every fixture widget must decode to its TYPED payload — a fallback
        // row for a known kind is a decoder regression.
        for (TranscriptModels.Message message
                : loadGoldenFrame().messages) {
            for (TranscriptModels.Segment segment : message.segments) {
                if (segment instanceof TranscriptModels.WidgetSegment) {
                    TranscriptModels.WidgetSegment widget =
                            (TranscriptModels.WidgetSegment) segment;
                    assertTrue("typed payload for " + widget.widgetKind,
                            widget.hasTypedPayload());
                }
            }
        }
    }

    // ── Widget payload spot checks ──────────────────────────────────────

    @Test
    public void decodesChoiceFormPermissionSecretDetails() throws Exception {
        TranscriptModels.Frame frame = loadGoldenFrame();
        Map<String, TranscriptModels.Message> byId = new LinkedHashMap<>();
        for (TranscriptModels.Message message : frame.messages) {
            byId.put(message.id, message);
        }

        TranscriptModels.WidgetSegment choiceSegment =
                (TranscriptModels.WidgetSegment) byId
                        .get("first-run:cloud-oauth").segments.get(1);
        assertNotNull(choiceSegment.choice);
        assertEquals("first-run", choiceSegment.choice.scope);
        assertTrue(choiceSegment.choice.isFirstRun());
        assertEquals("__first_run__:runtime:cloud",
                choiceSegment.choice.options.get(0).value);

        TranscriptModels.WidgetSegment formSegment =
                (TranscriptModels.WidgetSegment) byId
                        .get("golden-assistant-0").segments.get(1);
        assertNotNull(formSegment.form);
        assertEquals("onboarding-profile", formSegment.form.id);
        assertEquals(3, formSegment.form.fields.size());
        assertTrue(formSegment.form.fields.get(0).required);
        assertEquals("select", formSegment.form.fields.get(1).type);
        assertEquals(3, formSegment.form.fields.get(1).options.size());
        assertEquals("checkbox", formSegment.form.fields.get(2).type);

        TranscriptModels.PermissionSegment permission =
                (TranscriptModels.PermissionSegment) byId
                        .get("golden-assistant-1").segments.get(1);
        assertEquals("reminders", permission.permission);
        assertEquals("onboarding.reminders", permission.feature);
        assertTrue(permission.fallbackOffered);

        TranscriptModels.SecretRequest secret =
                byId.get("golden-assistant-2").secretRequest;
        assertNotNull(secret);
        assertEquals("HARNESS_API_KEY", secret.key);
        assertEquals("secret", secret.formKind);
        assertTrue(secret.canCollectInChannel);
        assertEquals(1, secret.fields.size());
        assertEquals("secret", secret.fields.get(0).input);
        assertTrue(secret.fields.get(0).required);

        TranscriptModels.Message toolTurn = byId.get("golden-assistant-5");
        assertNotNull(toolTurn.reasoning);
        assertEquals(2, toolTurn.toolEvents.size());
        assertEquals("CALENDAR_FIND_EVENTS",
                toolTurn.toolEvents.get(0).actionName);
        assertEquals("completed", toolTurn.toolEvents.get(0).status);
        assertEquals(412, toolTurn.toolEvents.get(0).durationMs);
        assertEquals("running", toolTurn.toolEvents.get(1).status);

        assertEquals("rate_limited",
                byId.get("golden-assistant-10").failureKind);

        TranscriptModels.CodeSegment code =
                (TranscriptModels.CodeSegment) byId
                        .get("golden-assistant-8").segments.get(1);
        assertEquals("tsx", code.lang);
        assertTrue(!code.inline);
    }

    // ── Tolerance (unknown kinds → fallback, never a throw) ────────────

    @Test
    public void unknownKindsDecodeToFallbacks() {
        TranscriptModels.Segment unknownSegment =
                TranscriptModels.decodeSegment(new JSONObject(
                        "{\"kind\":\"hologram\",\"payload\":42}"));
        assertTrue(unknownSegment
                instanceof TranscriptModels.UnknownSegment);
        assertEquals("hologram", unknownSegment.kind);

        TranscriptModels.Segment unknownWidget =
                TranscriptModels.decodeSegment(new JSONObject(
                        "{\"kind\":\"widget\",\"widgetKind\":\"sparkline\","
                                + "\"data\":{\"points\":[1,2]}}"));
        assertTrue(unknownWidget instanceof TranscriptModels.WidgetSegment);
        assertTrue(!((TranscriptModels.WidgetSegment) unknownWidget)
                .hasTypedPayload());
    }

    // ── Action-string formatters (DOM sendActionMessage parity) ────────

    @Test
    public void actionStringsMatchDomProtocol() throws Exception {
        assertEquals("__first_run__:runtime:cloud",
                TranscriptActions.choice("__first_run__:runtime:cloud"));
        assertEquals("Show me widgets",
                TranscriptActions.followup("Show me widgets"));

        Map<String, Object> values = new LinkedHashMap<>();
        values.put("name", "Shaw");
        values.put("focus", "both");
        values.put("daily", true);
        String formAction = TranscriptActions.formSubmit(
                "onboarding-profile", values);
        assertTrue(formAction.startsWith("[form:submit onboarding-profile] "));
        JSONObject decoded = new JSONObject(formAction.substring(
                "[form:submit onboarding-profile] ".length()));
        assertEquals("Shaw", decoded.getString("name"));
        assertEquals("both", decoded.getString("focus"));
        assertEquals(true, decoded.getBoolean("daily"));

        assertEquals(
                "__permission_card__:use_fallback"
                        + " feature=onboarding.reminders"
                        + " permission=reminders",
                TranscriptActions.permissionFallback("onboarding.reminders",
                        "reminders"));
        assertEquals(
                "__permission_card__:granted feature=onboarding.reminders"
                        + " permission=reminders",
                TranscriptActions.permissionGranted("onboarding.reminders",
                        "reminders"));
        assertEquals(
                "Please show me the configuration form for the discord"
                        + " plugin",
                TranscriptActions.openPluginConfig("discord"));
        assertEquals("Set the app background to #1a0c06",
                TranscriptActions.backgroundPick("#1a0c06"));

        Map<String, String> oneSecret = new LinkedHashMap<>();
        oneSecret.put("HARNESS_API_KEY", "sk-test-123");
        assertEquals("sk-test-123",
                TranscriptActions.secretSubmit(oneSecret));
        Map<String, String> twoSecrets = new LinkedHashMap<>(oneSecret);
        twoSecrets.put("SECOND", "v2");
        assertEquals("HARNESS_API_KEY=sk-test-123\nSECOND=v2",
                TranscriptActions.secretSubmit(twoSecrets));
    }

    // ── Histograms ──────────────────────────────────────────────────────

    private static Map<String, Integer> segmentHistogram(
            TranscriptModels.Frame frame) {
        Map<String, Integer> histogram = new TreeMap<>();
        for (TranscriptModels.Message message : frame.messages) {
            for (TranscriptModels.Segment segment : message.segments) {
                histogram.merge(segment.kind, 1, Integer::sum);
            }
        }
        return histogram;
    }

    private static Map<String, Integer> widgetHistogram(
            TranscriptModels.Frame frame) {
        Map<String, Integer> histogram = new TreeMap<>();
        for (TranscriptModels.Message message : frame.messages) {
            for (TranscriptModels.Segment segment : message.segments) {
                if (segment instanceof TranscriptModels.WidgetSegment) {
                    histogram.merge(((TranscriptModels.WidgetSegment) segment)
                            .widgetKind, 1, Integer::sum);
                }
            }
        }
        return histogram;
    }

    // ── Plain-java entrypoint (see file header, path 2) ─────────────────

    public static void main(String[] args) throws Exception {
        TranscriptContractTest test = new TranscriptContractTest();
        test.decodesGoldenFrameShape();
        test.segmentKindHistogramMatchesGolden();
        test.widgetKindHistogramCoversAllSevenKinds();
        test.decodesChoiceFormPermissionSecretDetails();
        test.unknownKindsDecodeToFallbacks();
        test.actionStringsMatchDomProtocol();

        TranscriptModels.Frame frame = loadGoldenFrame();
        System.out.println("fixture: " + resolveFixture());
        System.out.println("schema: " + frame.schema);
        System.out.println("messages: " + frame.messages.size());
        System.out.println("segment histogram: " + segmentHistogram(frame));
        System.out.println("widget histogram: " + widgetHistogram(frame));
        System.out.println(
                "TranscriptContractTest: ALL CHECKS PASSED (6/6)");
    }
}
