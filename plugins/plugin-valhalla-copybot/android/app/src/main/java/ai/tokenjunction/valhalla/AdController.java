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
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
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
    private final FrameLayout bannerSlot;
    private final TextView note;
    private final TextView houseCount;
    private final SessionStore store;
    private AdView banner;
    private boolean houseReady;
    private String houseUrl = "";
    private String houseId = "";
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
        bannerSlot = activity.findViewById(R.id.adSlot);
        note = activity.findViewById(R.id.adNote);
        houseCount = activity.findViewById(R.id.houseCount);
        store = new SessionStore(activity);
        rewardedButton.setOnClickListener(v -> showRewarded());
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

    /** A break ad after the error log. Never while a stall or offline alert is showing. */
    void onNaturalBreak(boolean alertShowing) {
        if (!BuildConfig.ADS_ENABLED || alertShowing || interstitial == null) return;
        long now = System.currentTimeMillis();
        if (now - store.lastBreakAt() < 10 * 60 * 1000L) return;
        store.markBreak();
        interstitial.show(activity);
    }

    void onScreen(String screen) {
        if (!BuildConfig.ADS_ENABLED) {
            column.setVisibility(View.GONE);
            return;
        }
        // Banner sits under the dashboard. Pairing and settings stay clear. Pro hides it.
        boolean show = store.adsAllowed() && SessionStore.SCREEN_STATUS.equals(screen);
        column.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) applyRotation();
    }

    /** Even minutes show AdMob. Odd minutes show a house offer when one URL is set. */
    private void applyRotation() {
        boolean houseTurn = houseReady && (System.currentTimeMillis() / 60000L) % 2L == 1L;
        bannerSlot.setVisibility(houseTurn ? View.GONE : View.VISIBLE);
        int vis = houseTurn ? View.VISIBLE : View.GONE;
        houseTitle.setVisibility(vis);
        houseText.setVisibility(vis);
        houseLink.setVisibility(houseTurn ? View.VISIBLE : View.GONE);
        houseCount.setVisibility(houseReady ? View.VISIBLE : View.GONE);
    }

    void destroy() {
        if (banner != null) banner.destroy();
    }

    private void startAdMob() {
        if (admobStarted) return;
        if (BuildConfig.ADMOB_BANNER_ID == null || BuildConfig.ADMOB_BANNER_ID.isEmpty()) return;
        admobStarted = true;
        MobileAds.initialize(activity);
        banner = new AdView(activity);
        banner.setAdUnitId(BuildConfig.ADMOB_BANNER_ID);
        int widthPx = activity.getResources().getDisplayMetrics().widthPixels;
        int adWidth = (int) (widthPx / activity.getResources().getDisplayMetrics().density);
        banner.setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, Math.max(adWidth, 320)));
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
        String offers = readNamed("offers.json");
        if (!offers.isEmpty()) return offers;
        return readNamed("house-ads.json");
    }

    private String readNamed(String name) {
        try (InputStream in = activity.getAssets().open(name)) {
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
        houseReady = false;
        houseUrl = "";
        houseId = "";
        try {
            JSONObject root = new JSONObject(raw);
            ArrayList<JSONObject> rows = new ArrayList<>();
            JSONArray offers = root.optJSONArray("offers");
            if (offers != null) {
                for (int i = 0; i < offers.length(); i++) {
                    JSONObject row = offers.getJSONObject(i);
                    if (!row.optString("url", "").trim().startsWith("https://")) continue;
                    JSONArray places = row.optJSONArray("placements");
                    boolean banner = false;
                    if (places != null) {
                        for (int p = 0; p < places.length(); p++) {
                            if ("app-banner".equals(places.optString(p))) banner = true;
                        }
                    }
                    if (banner) rows.add(row);
                }
            }
            JSONObject chosen = null;
            if (!rows.isEmpty()) {
                int day = (int) ((System.currentTimeMillis() / 86400000L) % rows.size());
                chosen = rows.get(day);
            }
            if (chosen == null) {
                applyRotation();
                return;
            }
            houseUrl = chosen.optString("url", "").trim();
            houseId = chosen.optString("id", "offer");
            houseTitle.setText(chosen.optString("title", ""));
            houseText.setText(chosen.optString("blurb", "") + "\nAffiliate link · we may earn a commission. Not trading advice.");
            houseReady = houseUrl.startsWith("https://");
            store.countHouseImpression();
            houseCount.setText(activity.getString(R.string.house_count, store.houseImpressions(), store.houseClicks()));
            final String openUrl = houseUrl;
            final String openId = houseId;
            houseLink.setOnClickListener(v -> {
                store.countHouseClick();
                houseCount.setText(activity.getString(R.string.house_count, store.houseImpressions(), store.houseClicks()));
                trackClick(openId, "app-banner");
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(openUrl)));
            });
        } catch (Exception ignored) {
            houseReady = false;
        }
        applyRotation();
    }

    /** Sends the offer id and placement only. No account or device id is added. */
    private void trackClick(String id, String placement) {
        String endpoint = BuildConfig.OFFER_CLICK_URL == null ? "" : BuildConfig.OFFER_CLICK_URL.trim();
        if (!endpoint.startsWith("https://")) return;
        if (!id.matches("[a-z0-9-]{1,40}") || !placement.matches("[a-z0-9-]{1,40}")) return;
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(endpoint).openConnection();
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setRequestProperty("content-type", "application/json");
                byte[] body = ("{\"id\":\"" + id + "\",\"placement\":\"" + placement + "\"}").getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body);
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // A missed count does not block the link.
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
