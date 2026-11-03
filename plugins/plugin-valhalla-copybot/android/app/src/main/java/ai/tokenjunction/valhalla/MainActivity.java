package ai.tokenjunction.valhalla;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.JSONObject;

/** Phone companion. It never stores a wallet key and has no send or withdraw control. */
public class MainActivity extends AppCompatActivity {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AdController ads;
    private SessionStore store;
    private ErrorLog errors;
    private DeskClient client;
    private boolean offline;
    private View pairingBlock;
    private View statusBlock;
    private View chatBlock;
    private View errorBlock;
    private TextView cacheBanner;
    private TextView status;
    private TextView liveStatus;
    private TextView pnl;
    private TextView positions;
    private TextView chatLog;
    private TextView suggestionView;
    private TextView errorView;
    private EditText deskUrl;
    private EditText accessCode;
    private EditText chatInput;
    private Button confirmSuggestion;
    private String visibleScreen = SessionStore.SCREEN_PAIRING;

    private final BroadcastReceiver updates = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String kind = intent.getStringExtra("kind");
            offline = "offline".equals(kind) || "pair".equals(kind);
            if ("pair".equals(kind)) showScreen(SessionStore.SCREEN_PAIRING);
            renderState();
            renderErrors();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        store = new SessionStore(this);
        errors = new ErrorLog(this);
        client = new DeskClient(store, errors);
        bindViews();
        ads = new AdController(this);
        ads.start();
        deskUrl.setText(store.deskUrl());
        accessCode.setText(store.accessCode());
        chatLog.setText(store.chatLog());
        askForNotifications();
        String screen = store.lastScreen();
        if (store.deskUrl().isEmpty()) screen = SessionStore.SCREEN_PAIRING;
        showScreen(screen);
        renderState();
        if (!store.deskUrl().isEmpty()) startWatch();
    }

    private void bindViews() {
        pairingBlock = findViewById(R.id.pairingBlock);
        statusBlock = findViewById(R.id.statusBlock);
        chatBlock = findViewById(R.id.chatBlock);
        errorBlock = findViewById(R.id.errorBlock);
        cacheBanner = findViewById(R.id.cacheBanner);
        status = findViewById(R.id.status);
        liveStatus = findViewById(R.id.liveStatus);
        pnl = findViewById(R.id.pnl);
        positions = findViewById(R.id.positions);
        chatLog = findViewById(R.id.chatLog);
        suggestionView = findViewById(R.id.suggestion);
        errorView = findViewById(R.id.errorLog);
        deskUrl = findViewById(R.id.deskUrl);
        accessCode = findViewById(R.id.accessCode);
        chatInput = findViewById(R.id.chatInput);
        confirmSuggestion = findViewById(R.id.confirmSuggestion);
        findViewById(R.id.connect).setOnClickListener(v -> pair());
        findViewById(R.id.scanQr).setOnClickListener(v -> scanQr());
        findViewById(R.id.privacyPolicy).setOnClickListener(v -> openPrivacy());
        findViewById(R.id.deleteData).setOnClickListener(v -> deletePhoneData());
        findViewById(R.id.recover).setOnClickListener(v -> recover());
        findViewById(R.id.openChat).setOnClickListener(v -> showScreen(SessionStore.SCREEN_CHAT));
        findViewById(R.id.openErrors).setOnClickListener(v -> {
            renderErrors();
            showScreen(SessionStore.SCREEN_ERRORS);
        });
        findViewById(R.id.stopWatch).setOnClickListener(v -> {
            stopService(new Intent(this, CompanionService.class));
            status.setText("Background alerts are off. The screen still reconnects while it is open.");
        });
        findViewById(R.id.chatSend).setOnClickListener(v -> sendChat());
        findViewById(R.id.chatBack).setOnClickListener(v -> showScreen(SessionStore.SCREEN_STATUS));
        findViewById(R.id.errorBack).setOnClickListener(v -> showScreen(SessionStore.SCREEN_STATUS));
        confirmSuggestion.setOnClickListener(v -> confirmSuggestion());
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(CompanionService.ACTION_UPDATE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updates, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updates, filter);
        }
    }

    @Override
    protected void onStop() {
        unregisterReceiver(updates);
        super.onStop();
    }

    private void pair() {
        String url = deskUrl.getText() == null ? "" : deskUrl.getText().toString().trim();
        String code = accessCode.getText() == null ? "" : accessCode.getText().toString();
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            status.setText("Use a full address that starts with http:// or https://.");
            return;
        }
        store.saveDesk(url, code);
        status.setText("Pairing…");
        io.execute(() -> {
            DeskClient.Result result = client.pair();
            runOnUiThread(() -> {
                if (!result.ok) {
                    errors.add(result.message);
                    offline = true;
                    showScreen(SessionStore.SCREEN_PAIRING);
                    status.setText(result.message);
                    renderState();
                    return;
                }
                offline = false;
                startWatch();
                showScreen(SessionStore.SCREEN_STATUS);
                refresh();
            });
        });
    }

    private void refresh() {
        io.execute(() -> {
            DeskClient.Result result = client.heartbeat();
            runOnUiThread(() -> {
                offline = !result.ok;
                if (result.tokenExpired) showScreen(SessionStore.SCREEN_PAIRING);
                renderState();
            });
        });
    }

    private void recover() {
        liveStatus.setText("Asking the PC agent to recover…");
        io.execute(() -> {
            DeskClient.Result result = client.recover();
            runOnUiThread(() -> {
                offline = !result.ok;
                liveStatus.setText(result.message);
                if (!result.ok) errors.add(result.message);
                refresh();
            });
        });
    }

    private void sendChat() {
        String text = chatInput.getText() == null ? "" : chatInput.getText().toString().trim();
        if (text.isEmpty()) return;
        chatInput.setText("");
        appendChat("You: " + text);
        io.execute(() -> {
            DeskClient.Result result = client.chat(text);
            runOnUiThread(() -> {
                if (!result.ok) {
                    offline = true;
                    appendChat("Agent: " + result.message);
                    errors.add(result.message);
                    return;
                }
                appendChat("Agent: " + result.message);
                if (result.suggestion == null || result.suggestion.isEmpty()) {
                    store.saveSuggestion("");
                    suggestionView.setVisibility(View.GONE);
                    confirmSuggestion.setVisibility(View.GONE);
                } else {
                    store.saveSuggestion(result.suggestion);
                    suggestionView.setText("Suggested change, not applied yet:\n" + summarize(result.suggestion));
                    suggestionView.setVisibility(View.VISIBLE);
                    confirmSuggestion.setVisibility(View.VISIBLE);
                }
            });
        });
    }

    private void confirmSuggestion() {
        String json = store.suggestion();
        if (json.isEmpty()) return;
        confirmSuggestion.setEnabled(false);
        io.execute(() -> {
            DeskClient.Result result = client.confirm(json);
            runOnUiThread(() -> {
                confirmSuggestion.setEnabled(true);
                appendChat("Agent: " + result.message);
                if (result.ok) {
                    store.saveSuggestion("");
                    suggestionView.setVisibility(View.GONE);
                    confirmSuggestion.setVisibility(View.GONE);
                } else {
                    errors.add(result.message);
                }
            });
        });
    }

    private void appendChat(String line) {
        String next = store.chatLog();
        if (!next.isEmpty()) next = next + "\n";
        next = next + line;
        store.saveChat(next);
        chatLog.setText(next);
    }

    private void renderState() {
        cacheBanner.setVisibility(offline && !store.cachedState().isEmpty() ? View.VISIBLE : View.GONE);
        String raw = store.cachedState();
        if (raw.isEmpty()) {
            liveStatus.setText(offline ? "No saved state yet." : "Waiting for the PC agent.");
            pnl.setText("");
            positions.setText("");
            return;
        }
        try {
            JSONObject state = new JSONObject(raw);
            liveStatus.setText(state.optString("status", "Last known status"));
            pnl.setText(state.optString("pnl", ""));
            positions.setText(state.optString("positions", ""));
            org.json.JSONArray links = state.optJSONArray("connections");
            if (links != null) {
                StringBuilder lines = new StringBuilder(positions.getText());
                for (int i = 0; i < links.length(); i++) {
                    org.json.JSONObject row = links.optJSONObject(i);
                    if (row == null) continue;
                    lines.append("\n").append(row.optString("label")).append(" ").append(row.optString("state"));
                }
                positions.setText(lines.toString());
            }
        } catch (Exception err) {
            liveStatus.setText("The saved state could not be read.");
            errors.add(liveStatus.getText().toString());
        }
    }

    private void renderErrors() {
        errorView.setText(errors.text());
    }

    private void showScreen(String screen) {
        boolean leftErrors = SessionStore.SCREEN_ERRORS.equals(visibleScreen)
                && !SessionStore.SCREEN_ERRORS.equals(screen);
        visibleScreen = screen;
        store.saveScreen(screen);
        pairingBlock.setVisibility(SessionStore.SCREEN_PAIRING.equals(screen) ? View.VISIBLE : View.GONE);
        statusBlock.setVisibility(SessionStore.SCREEN_STATUS.equals(screen) ? View.VISIBLE : View.GONE);
        chatBlock.setVisibility(SessionStore.SCREEN_CHAT.equals(screen) ? View.VISIBLE : View.GONE);
        errorBlock.setVisibility(SessionStore.SCREEN_ERRORS.equals(screen) ? View.VISIBLE : View.GONE);
        if (SessionStore.SCREEN_CHAT.equals(screen)) chatLog.setText(store.chatLog());
        if (SessionStore.SCREEN_ERRORS.equals(screen)) renderErrors();
        if (ads != null) {
            ads.onScreen(screen);
            if (leftErrors) ads.onNaturalBreak(offline);
        }
    }

    private void scanQr() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] {Manifest.permission.CAMERA}, 42);
            return;
        }
        IntentIntegrator integrator = new IntentIntegrator(this);
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        integrator.setPrompt("Point at the desk address QR. Not a wallet key.");
        integrator.setBeepEnabled(false);
        integrator.setOrientationLocked(false);
        integrator.initiateScan();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            if (result.getContents() != null) applyQr(result.getContents());
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 42 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            scanQr();
        }
    }

    private void applyQr(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (!(text.startsWith("http://") || text.startsWith("https://")) || text.length() > 200) {
            status.setText("That QR is not a desk address. The phone does not accept a wallet key.");
            errors.add("Rejected a QR that was not a desk address.");
            return;
        }
        deskUrl.setText(text);
        status.setText("Desk address read from the QR. Pair when you are ready.");
    }

    private void deletePhoneData() {
        store.clearPhoneData();
        errors.clear();
        stopService(new Intent(this, CompanionService.class));
        deskUrl.setText("");
        accessCode.setText("");
        chatLog.setText("");
        offline = false;
        visibleScreen = SessionStore.SCREEN_PAIRING;
        showScreen(SessionStore.SCREEN_PAIRING);
        status.setText(getString(R.string.status_idle));
    }

    private void openPrivacy() {
        String url = BuildConfig.PRIVACY_POLICY_URL == null ? "" : BuildConfig.PRIVACY_POLICY_URL.trim();
        if (url.startsWith("https://")) {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.privacy_policy)
                .setMessage(R.string.privacy_fallback)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    private void startWatch() {
        Intent intent = new Intent(this, CompanionService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(this, new String[] {Manifest.permission.POST_NOTIFICATIONS}, 41);
    }

    private static String summarize(String json) {
        try {
            JSONObject settings = new JSONObject(json);
            return "preset " + settings.optString("preset")
                    + " · max buy " + settings.optDouble("ticketMaxSol")
                    + " SOL · stop " + settings.optDouble("stopLossPct");
        } catch (Exception err) {
            return "Review the change, then confirm.";
        }
    }

    @Override
    protected void onDestroy() {
        if (ads != null) ads.destroy();
        io.shutdownNow();
        super.onDestroy();
    }
}
