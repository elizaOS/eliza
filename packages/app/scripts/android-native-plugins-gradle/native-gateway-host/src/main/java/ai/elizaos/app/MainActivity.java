package ai.elizaos.app;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** Minimal visible host. The service is the unmodified production source. */
public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        text.setText("Production gateway service lifecycle verification");
        setContentView(text);
        getSharedPreferences("CapacitorStorage", MODE_PRIVATE).edit()
            .putString("eliza:mobile-runtime-mode", getIntent().getStringExtra("runtimeMode"))
            .commit();
        GatewayConnectionService.start(this);
    }
}
