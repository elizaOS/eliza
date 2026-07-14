/**
 * Debug-only focused editor for device automation to exercise the installed
 * Eliza input method through Android's real InputMethodManager boundary.
 */
package ai.elizaos.app;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowInsets;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

public final class ElizaImeProbeActivity extends Activity {
    private static final String TAG = "ElizaImeProbe";
    private EditText editor;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);

        editor = new EditText(this);
        editor.setHint("Eliza IME verification editor");
        editor.setGravity(Gravity.TOP | Gravity.START);
        editor.setMinLines(8);
        editor.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        editor.setShowSoftInputOnFocus(true);
        editor.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(editor);
        editor.requestFocus();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        editor.postDelayed(() -> {
            InputMethodManager manager = getSystemService(InputMethodManager.class);
            if (manager != null) manager.restartInput(editor);
            boolean requested = manager != null
                    && manager.showSoftInput(editor, InputMethodManager.SHOW_FORCED);
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R
                    && editor.getWindowInsetsController() != null) {
                editor.getWindowInsetsController().show(WindowInsets.Type.ime());
            }
            Log.i(TAG, "[ElizaImeProbeActivity] IME display requested=" + requested
                    + " active=" + (manager != null && manager.isActive(editor))
                    + " acceptingText=" + (manager != null && manager.isAcceptingText()));
        }, 300);
    }
}
