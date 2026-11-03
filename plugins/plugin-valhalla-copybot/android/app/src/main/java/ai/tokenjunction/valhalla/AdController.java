package ai.tokenjunction.valhalla;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Ads sit on the pairing and error screens only.
 * They are not shown over Recover, chat, or a settings confirm.
 */
final class AdController {
    private final Activity activity;
    private final View column;
    private final TextView houseTitle;
    private final TextView houseText;
    private final Button houseLink;
    private final Button rewardedButton;
    private final Button interstitialButton;
    private final FrameLayout bannerSlot;
    private final TextView note;
    private AdView banner;
    private RewardedAd rewarded;
    private InterstitialAd interstitial;
    private boolean admobStarted;

    AdController(Activity activity) {
        this.activity = activity;
        column = activity.findViewById(R.id.adColumn);
        houseTitle = activity.findViewById(R.id.houseTitle);
        houseText = activity.findViewById(R.id.houseText);
        houseLink = activity.findViewById(R.id.houseLink);
        rewardedButton = activity.findViewById(R.id.rewardedAd);
        interstitialButton = activity.findViewById(R.id.interstitialAd);
        bannerSlot = activity.findViewById(R.id.adSlot);
        note = activity.findViewById(R.id.adNote);
        rewardedButton.setOnClickListener(v -> showRewarded());
        interstitialButton.setOnClickListener(v -> showInterstitial());
    }

    void start() {
        try {
            startAds();
        } catch (Throwable ignored) {
            column.setVisibility(View.GONE);
        }
    }

    private void startAds() {
        if (!BuildConfig.ADS_ENABLED) {
            column.setVisibility(View.GONE);
            return;
        }
        loadHouseAds();
        ConsentInformation consent = UserMessagingPlatform.getConsentInformation(activity);
        ConsentRequestParameters params = new ConsentRequestParameters.Builder().build();
        consent.requestConsentInfoUpdate(
                activity,
                params,
                () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                    if (consent.canRequestAds()) startAdMob();
                }),
                formError -> note.setText(activity.getString(R.string.ad_consent_unavailable)));
    }

    void onScreen(String screen) {
        if (!BuildConfig.ADS_ENABLED) {
            column.setVisibility(View.GONE);
            return;
        }
        boolean quiet = SessionStore.SCREEN_PAIRING.equals(screen) || SessionStore.SCREEN_ERRORS.equals(screen);
        column.setVisibility(quiet ? View.VISIBLE : View.GONE);
    }

    void destroy() {
        if (banner != null) banner.destroy();
    }

    private void startAdMob() {
        if (admobStarted) return;
        admobStarted = true;
        MobileAds.initialize(activity);
        banner = new AdView(activity);
        banner.setAdUnitId(BuildConfig.ADMOB_BANNER_ID);
        banner.setAdSize(AdSize.BANNER);
        bannerSlot.removeAllViews();
        bannerSlot.addView(banner);
        banner.loadAd(new AdRequest.Builder().build());
        loadRewarded();
        loadInterstitial();
    }

    private void loadRewarded() {
        RewardedAd.load(activity, BuildConfig.ADMOB_REWARDED_ID, new AdRequest.Builder().build(), new RewardedAdLoadCallback() {
            @Override
            public void onAdLoaded(RewardedAd ad) {
                rewarded = ad;
            }

            @Override
            public void onAdFailedToLoad(LoadAdError error) {
                rewarded = null;
            }
        });
    }

    private void loadInterstitial() {
        InterstitialAd.load(activity, BuildConfig.ADMOB_INTERSTITIAL_ID, new AdRequest.Builder().build(), new InterstitialAdLoadCallback() {
            @Override
            public void onAdLoaded(InterstitialAd ad) {
                interstitial = ad;
                ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                    @Override
                    public void onAdDismissedFullScreenContent() {
                        interstitial = null;
                        loadInterstitial();
                    }
                });
            }

            @Override
            public void onAdFailedToLoad(LoadAdError error) {
                interstitial = null;
            }
        });
    }

    private void showRewarded() {
        if (rewarded == null) {
            note.setText(activity.getString(R.string.ad_not_ready));
            return;
        }
        RewardedAd ad = rewarded;
        rewarded = null;
        ad.show(activity, rewardItem -> {
            note.setText(activity.getString(R.string.ad_thanks));
            loadRewarded();
        });
    }

    private void showInterstitial() {
        if (interstitial == null) {
            note.setText(activity.getString(R.string.ad_not_ready));
            return;
        }
        interstitial.show(activity);
    }

    private void loadHouseAds() {
        new Thread(() -> {
            String raw = readFeed();
            activity.runOnUiThread(() -> showHouse(raw));
        }).start();
    }

    private String readFeed() {
        String configured = BuildConfig.HOUSE_ADS_URL == null ? "" : BuildConfig.HOUSE_ADS_URL.trim();
        if (configured.startsWith("https://")) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(configured).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setInstanceFollowRedirects(false);
                if (conn.getResponseCode() != 200) return readAsset();
                return readStream(conn.getInputStream());
            } catch (Exception ignored) {
                return readAsset();
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        return readAsset();
    }

    private String readAsset() {
        try (InputStream in = activity.getAssets().open("house-ads.json")) {
            return readStream(in);
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String readStream(InputStream in) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null && out.length() < 20_000) out.append(line);
        return out.toString();
    }

    private void showHouse(String raw) {
        try {
            JSONArray ads = new JSONObject(raw).optJSONArray("ads");
            if (ads == null || ads.length() == 0) return;
            JSONObject ad = ads.getJSONObject(0);
            houseTitle.setText(ad.optString("title", ""));
            houseText.setText(ad.optString("text", ""));
            houseTitle.setVisibility(View.VISIBLE);
            houseText.setVisibility(View.VISIBLE);
            String url = ad.optString("url", "").trim();
            if (url.startsWith("https://")) {
                houseLink.setVisibility(View.VISIBLE);
                houseLink.setOnClickListener(v -> activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))));
            }
        } catch (Exception ignored) {
            houseTitle.setVisibility(View.GONE);
            houseText.setVisibility(View.GONE);
            houseLink.setVisibility(View.GONE);
        }
    }
}
