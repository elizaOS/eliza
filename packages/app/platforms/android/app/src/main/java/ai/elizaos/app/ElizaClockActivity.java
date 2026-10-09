/**
 * Opens the Clock request surface from Android's launcher. This Activity does
 * not receive alarm intents or own scheduling; external Android Clock handlers
 * own alarm effects after the reviewed device-operation path authorizes them.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public class ElizaClockActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(android.net.Uri.parse("elizaos://clock"));
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}
