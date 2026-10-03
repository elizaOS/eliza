package ai.elizaos.app;

import android.app.PendingIntent;
import android.net.Uri;
import android.os.Build;
import android.service.quicksettings.TileService;
import android.content.Intent;

public class ElizaVoiceTileService extends TileService {

    @Override
    public void onClick() {
        super.onClick();
        unlockAndRun(this::openVoiceChat);
    }

    private void openVoiceChat() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse(
                "elizaos://voice?source=android-quick-settings&action=voice&voice=1"));
        intent.setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP);

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
