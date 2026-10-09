package ai.elizaos.app;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.widget.TextView;

/** Minimal visible host. The service is the unmodified production source. */
public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView text = new TextView(this);
        String mode = getIntent().getStringExtra("runtimeMode");
        text.setText("Production gateway service\nLifecycle verification\nMode: " + mode);
        text.setTextColor(Color.BLACK);
        text.setTextSize(18);
        text.setGravity(Gravity.CENTER);
        setContentView(text);
        getSharedPreferences("CapacitorStorage", MODE_PRIVATE).edit()
            .putString("eliza:mobile-runtime-mode", mode)
            .commit();
        GatewayConnectionService.start(this);
    }
}
