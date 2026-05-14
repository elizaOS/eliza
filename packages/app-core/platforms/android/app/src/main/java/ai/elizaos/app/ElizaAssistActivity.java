package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class ElizaAssistActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(Uri.parse("ai.elizaos.app://chat?source=android-assist"));
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}
