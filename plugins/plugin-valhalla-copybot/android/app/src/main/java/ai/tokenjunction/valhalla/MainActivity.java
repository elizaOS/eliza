package ai.tokenjunction.valhalla;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.MobileAds;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Pairing screen. The phone never stores a wallet key. */
public class MainActivity extends AppCompatActivity {
    static final String TEST_BANNER = "ca-app-pub-3940256099942544/6300978111";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private TextView status;
    private EditText deskUrl;
    private WebView desk;
    private View pairingBlock;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.status);
        deskUrl = findViewById(R.id.deskUrl);
        desk = findViewById(R.id.desk);
        Button connect = findViewById(R.id.connect);
        desk.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showPairing("The desk did not answer. You can stay on this screen.");
                }
            }
        });
        connect.setOnClickListener(v -> checkDesk());
        loadTestAd();
    }

    private void loadTestAd() {
        try {
            MobileAds.initialize(this);
            AdView ad = new AdView(this);
            ad.setAdUnitId(TEST_BANNER);
            ad.setAdSize(AdSize.BANNER);
            FrameLayout slot = findViewById(R.id.adSlot);
            slot.addView(ad);
            ad.loadAd(new AdRequest.Builder().build());
        } catch (Throwable ignored) {
            status.setText(getString(R.string.status_idle));
        }
    }

    private void checkDesk() {
        String raw = deskUrl.getText() == null ? "" : deskUrl.getText().toString().trim();
        if (raw.isEmpty()) {
            showPairing("Enter the PC desk address when you are ready. The app is fine without it.");
            return;
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            showPairing("Use a full address that starts with http:// or https://.");
            return;
        }
        status.setText("Checking the desk…");
        io.execute(() -> {
            String message;
            boolean ok = false;
            HttpURLConnection conn = null;
            try {
                URL url = new URL(raw);
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("GET");
                int code = conn.getResponseCode();
                ok = code >= 200 && code < 400;
                message = ok ? "Desk answered." : "Desk returned " + code + ". Still on the pairing screen.";
            } catch (Exception err) {
                message = "No desk yet. " + (err.getMessage() == null ? "The check timed out." : err.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
            boolean open = ok;
            String finalMessage = message;
            runOnUiThread(() -> {
                if (open) openDesk(raw);
                else showPairing(finalMessage);
            });
        });
    }

    private void openDesk(String url) {
        status.setText("Connected. Read-only until you arm live on the PC.");
        desk.setVisibility(View.VISIBLE);
        desk.loadUrl(url);
    }

    private void showPairing(String message) {
        desk.setVisibility(View.GONE);
        status.setText(message);
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        super.onDestroy();
    }
}
