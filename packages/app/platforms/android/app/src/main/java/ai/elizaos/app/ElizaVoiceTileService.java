package ai.elizaos.app;

import android.content.Intent;
import android.net.Uri;

import ai.eliza.plugins.system.AssistantEntryTile;

/**
 * The voice entry in Quick Settings (shared {@link AssistantEntryTile}): an action tile that opens
 * voice chat after the owner unlocks. It keeps the manifest label and icon and never reports an
 * active state, so it does not suggest that listening or capture is on.
 */
public class ElizaVoiceTileService extends AssistantEntryTile {

    @Override
    protected Intent entryIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(
                "elizaos://voice?source=android-quick-settings&action=voice&voice=1"));
        intent.setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return intent;
    }
}
