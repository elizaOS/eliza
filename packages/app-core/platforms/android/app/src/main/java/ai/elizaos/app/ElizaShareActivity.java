package ai.elizaos.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;

import java.util.ArrayList;

public class ElizaShareActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        Uri route = buildRoute(source);

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        copySharedContentGrant(source, launch);
        startActivity(launch);
        finish();
    }

    private static Uri buildRoute(Intent source) {
        String sourceTag = resolveSourceTag(source);
        Uri.Builder route = Uri.parse("elizaos://chat")
                .buildUpon()
                .appendQueryParameter("source", sourceTag)
                .appendQueryParameter("action", "smart-reply");

        String text = extractText(source);
        if (!TextUtils.isEmpty(text)) {
            route.appendQueryParameter("text", text);
        }

        if (source != null) {
            String subject = source.getStringExtra(Intent.EXTRA_SUBJECT);
            if (!TextUtils.isEmpty(subject)) {
                route.appendQueryParameter("subject", subject);
            }
            String mimeType = source.getType();
            if (!TextUtils.isEmpty(mimeType)) {
                route.appendQueryParameter("mimeType", mimeType);
            }
            if (Intent.ACTION_PROCESS_TEXT.equals(source.getAction())) {
                route.appendQueryParameter(
                        "readonly",
                        String.valueOf(
                                source.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true)));
            }
            if (hasSharedStream(source)) {
                route.appendQueryParameter("attachment", "1");
            }
        }

        return route.build();
    }

    private static String resolveSourceTag(Intent source) {
        if (source == null) {
            return "android-share-sheet";
        }
        String action = source.getAction();
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            return "android-process-text";
        }
        if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            return "android-share-sheet-multiple";
        }
        return "android-share-sheet";
    }

    private static String extractText(Intent source) {
        if (source == null) {
            return null;
        }

        CharSequence processText = source.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
        if (!TextUtils.isEmpty(processText)) {
            return processText.toString();
        }

        CharSequence extraText = source.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (!TextUtils.isEmpty(extraText)) {
            return extraText.toString();
        }

        return null;
    }

    private static void copySharedContentGrant(Intent source, Intent launch) {
        if (source == null) {
            return;
        }
        ClipData clipData = source.getClipData();
        if (clipData != null) {
            launch.setClipData(clipData);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }

        Uri stream = source.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) {
            launch.putExtra(Intent.EXTRA_STREAM, stream);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return;
        }

        ArrayList<Uri> streams = source.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (streams != null && !streams.isEmpty()) {
            launch.putParcelableArrayListExtra(Intent.EXTRA_STREAM, streams);
            launch.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
    }

    private static boolean hasSharedStream(Intent source) {
        if (source == null) {
            return false;
        }
        Uri stream = source.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream != null) {
            return true;
        }
        ArrayList<Uri> streams = source.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        return streams != null && !streams.isEmpty();
    }
}
