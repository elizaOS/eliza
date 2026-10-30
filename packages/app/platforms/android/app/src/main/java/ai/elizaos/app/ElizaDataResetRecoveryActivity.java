package ai.elizaos.app;

import ai.eliza.plugins.system.reset.DataReset;
import ai.eliza.plugins.system.reset.DataResetCopy;
import ai.eliza.plugins.system.reset.DataResetRecoveryActivity;

/**
 * Shown when a confirmed "Reset app data" could not finish. The manifest declares it unexported in
 * its own {@link ElizaDataResetPlugin#RECOVERY_PROCESS_SUFFIX} process, where none of the app's
 * content providers or startup initializers run and the agent, renderer and notification code
 * never start. The surface (no completion claim, fresh retry, listener settings, Phone, Android
 * Settings) is the shared {@link DataResetRecoveryActivity}.
 */
public final class ElizaDataResetRecoveryActivity extends DataResetRecoveryActivity {
    @Override
    protected DataReset reset() {
        return ElizaApplication.DATA_RESET;
    }

    @Override
    protected DataResetCopy copy() {
        return ElizaDataResetPlugin.copyFor(ElizaDataResetPlugin.productName(this));
    }
}
