package ai.elizaos.app;

import android.app.PendingIntent;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.TileService;

/**
 * Shared launch path for Eliza's Quick Settings tiles (chat / voice /
 * transcribe). A tile tap is a one-shot deep link into MainActivity: unlock
 * first (tiles are tappable from the lock screen), then fire the elizaos://
 * VIEW intent and collapse the shade. Subclasses supply only the deep-link
 * URI; everything else — flags, the API-34 collapse contract — is identical
 * across tiles, so it lives here as the single codepath.
 *
 * The URIs carry source=android-qs-tile, which is in the renderer's trusted
 * assistant-launch set (packages/ui/src/platform/assistant-launch-payload.ts).
 * Capture launches (voice=1 / transcribe=1) are dropped by that claim gate for
 * any untrusted source, so the source value here is load-bearing, not
 * analytics.
 */
abstract class ElizaAssistantTileService extends TileService {

    /** The elizaos:// deep link this tile launches. */
    protected abstract String deepLinkUri();

    @Override
    public void onClick() {
        super.onClick();
        unlockAndRun(this::launchDeepLink);
    }

    private void launchDeepLink() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(deepLinkUri()));
        intent.setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        // API 34+ rejects the Intent overload of startActivityAndCollapse with
        // UnsupportedOperationException; the PendingIntent overload is the only
        // way to both launch and collapse the QS panel there.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pendingIntent);
            return;
        }

        startActivityAndCollapse(intent);
    }
}
