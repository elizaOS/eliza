/**
 * Eliza's call screen. Presentation and controls are the shared {@link TelecomCallActivity} in
 * plugin-native-phone; this non-exported activity keeps the installed component name.
 */
package ai.elizaos.app;

import ai.eliza.plugins.phone.TelecomCallActivity;

public final class ElizaInCallActivity extends TelecomCallActivity {
    @Override protected String title() { return "Eliza · Phone"; }
}
