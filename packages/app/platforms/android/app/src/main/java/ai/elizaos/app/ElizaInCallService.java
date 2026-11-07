/**
 * Eliza's dialer-role InCallService. The call lifecycle, notifications and controls are the shared
 * {@link TelecomCallService} in plugin-native-phone; this class keeps the installed component name
 * and the existing notification channel.
 */
package ai.elizaos.app;

import ai.eliza.plugins.phone.TelecomCallConfiguration;
import ai.eliza.plugins.phone.TelecomCallService;

public class ElizaInCallService extends TelecomCallService {
    private static final TelecomCallConfiguration CONFIGURATION =
            new TelecomCallConfiguration("eliza_phone_calls", "Phone calls", "eliza-call", ElizaInCallActivity.class);

    @Override protected TelecomCallConfiguration configuration() { return CONFIGURATION; }
}
