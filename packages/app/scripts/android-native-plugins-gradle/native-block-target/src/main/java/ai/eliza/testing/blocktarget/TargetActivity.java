package ai.eliza.testing.blocktarget;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Independent foreground app: its counter proves whether shielded taps reach it. */
public class TargetActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xfff3f5fa);
        TextView title = new TextView(this);
        title.setText("Native blocking test target");
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);
        root.addView(title, new FrameLayout.LayoutParams(-1, 200, Gravity.TOP));
        Button button = new Button(this);
        button.setAllCaps(false);
        var prefs = getSharedPreferences("counter", MODE_PRIVATE);
        button.setText("Tap count: " + prefs.getInt("count", 0));
        button.setOnClickListener(view -> {
            int count = prefs.getInt("count", 0) + 1;
            prefs.edit().putInt("count", count).apply();
            button.setText("Tap count: " + count);
        });
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, 180, Gravity.BOTTOM);
        params.bottomMargin = 100;
        root.addView(button, params);
        setContentView(root);
    }
}
