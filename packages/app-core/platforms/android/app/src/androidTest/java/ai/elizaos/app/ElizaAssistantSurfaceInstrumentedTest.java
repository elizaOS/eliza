package ai.elizaos.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import java.util.List;

/**
 * Retail-path (non-{@code assumeSystemEliza}) assertions that Eliza's Android
 * assistant surfaces survived install-time manifest parsing on ANY debug build.
 *
 * The pre-existing {@code ElizaOsInstrumentedTest} only asserts held default
 * roles, and every one of its cases {@code assumeSystemEliza()}-gates to the
 * {@code /system/priv-app/Eliza/} AOSP APK — so on a normal sideload/CI APK it
 * vacuously assume-skips and the {@code :app:} androidTest run proves nothing.
 * This class fixes that (#13581): its assertions run on the plain debug APK the
 * emulator installs, so wiring {@code :app:connectedDebugAndroidTest} into CI
 * is not green-by-skip.
 *
 * These are the checks that regress when a manifest edit or a missing paired
 * service (e.g. a VoiceInteractionService whose recognitionService is absent —
 * the framework then rejects it and it never appears as an assistant candidate)
 * silently drops a surface. The lane's device-side adb scrape (dumpsys/cmd)
 * covers the *runtime* role/IME selection; this covers the *declaration* that
 * must exist before any of that can work.
 */
@RunWith(AndroidJUnit4.class)
public class ElizaAssistantSurfaceInstrumentedTest {

    private static final String PACKAGE_NAME = "ai.elizaos.app";

    private Context context() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext();
    }

    private ServiceInfo declaredService(String className) throws Exception {
        ComponentName component = new ComponentName(PACKAGE_NAME, className);
        // GET_META_DATA so the parse of the service's <meta-data> (voice
        // interaction / input-method descriptors) is exercised too — a broken
        // descriptor throws NameNotFoundException here.
        return context().getPackageManager()
                .getServiceInfo(component, PackageManager.GET_META_DATA);
    }

    @Test
    public void voiceInteractionServiceIsDeclaredAndBindGuarded() throws Exception {
        ServiceInfo info = declaredService("ai.elizaos.app.ElizaVoiceInteractionService");
        assertNotNull("ElizaVoiceInteractionService must be declared", info);
        assertTrue("VIS must be exported so the framework can bind it", info.exported);
        assertTrue(
                "VIS must be guarded by BIND_VOICE_INTERACTION",
                "android.permission.BIND_VOICE_INTERACTION".equals(info.permission));
    }

    @Test
    public void pairedSessionAndRecognitionServicesAreDeclared() throws Exception {
        // The VoiceInteractionServiceInfo parser rejects the VIS unless BOTH the
        // session and recognition services it references exist; asserting they
        // are present is asserting the VIS could parse at all.
        assertNotNull(declaredService("ai.elizaos.app.ElizaVoiceInteractionSessionService"));
        assertNotNull(declaredService("ai.elizaos.app.ElizaRecognitionService"));
    }

    @Test
    public void voiceImeIsDeclaredAndBindGuarded() throws Exception {
        ServiceInfo info = declaredService("ai.elizaos.app.ElizaVoiceInputMethodService");
        assertNotNull("ElizaVoiceInputMethodService must be declared", info);
        assertTrue("IME must be exported", info.exported);
        assertTrue(
                "IME must be guarded by BIND_INPUT_METHOD",
                "android.permission.BIND_INPUT_METHOD".equals(info.permission));
    }

    @Test
    public void voiceImeResolvesForTheInputMethodAction() {
        Intent imeIntent = new Intent("android.view.InputMethod");
        List<ResolveInfo> resolved = context().getPackageManager()
                .queryIntentServices(imeIntent, 0);
        boolean elizaImePresent = false;
        for (ResolveInfo candidate : resolved) {
            if (candidate.serviceInfo != null
                    && PACKAGE_NAME.equals(candidate.serviceInfo.packageName)
                    && "ai.elizaos.app.ElizaVoiceInputMethodService"
                            .equals(candidate.serviceInfo.name)) {
                elizaImePresent = true;
                break;
            }
        }
        assertTrue(
                "Eliza voice IME must resolve for android.view.InputMethod",
                elizaImePresent);
    }

    @Test
    public void assistActivityResolvesTheAssistAction() {
        // ACTION_ASSIST must resolve to Eliza's fallback assist activity (the OEM
        // direct-intent path that stays valid whether or not the role is held).
        Intent assist = new Intent(Intent.ACTION_ASSIST);
        assist.setPackage(PACKAGE_NAME);
        ResolveInfo resolved = context().getPackageManager()
                .resolveActivity(assist, 0);
        assertNotNull("ACTION_ASSIST must resolve within Eliza", resolved);
        assertTrue(
                "ACTION_ASSIST must route to ElizaAssistActivity",
                resolved.activityInfo != null
                        && "ai.elizaos.app.ElizaAssistActivity"
                                .equals(resolved.activityInfo.name));
    }

    @Test
    public void voiceCommandActionResolvesWithinEliza() {
        Intent voiceCommand = new Intent(Intent.ACTION_VOICE_COMMAND);
        voiceCommand.setPackage(PACKAGE_NAME);
        ResolveInfo resolved = context().getPackageManager()
                .resolveActivity(voiceCommand, 0);
        assertNotNull("ACTION_VOICE_COMMAND must resolve within Eliza", resolved);
    }
}
