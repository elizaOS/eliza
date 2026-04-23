package ai.elizaos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

public class MiladyDialActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        Uri data = source != null ? source.getData() : null;
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        Uri.Builder route = Uri.parse("ai.elizaos.app://phone").buildUpon()
                .appendQueryParameter("source", "android-dial");
        if (data != null) {
            route.appendQueryParameter("uri", data.toString());
        }
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }
}
