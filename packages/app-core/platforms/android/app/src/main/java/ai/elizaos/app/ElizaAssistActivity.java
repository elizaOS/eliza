package ai.elizaos.app;

import android.app.Activity;
import android.app.SearchManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.text.TextUtils;

import java.util.ArrayList;

public class ElizaAssistActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Intent source = getIntent();
        String action = source != null ? source.getAction() : null;
        boolean voiceCommand = Intent.ACTION_VOICE_COMMAND.equals(action);
        String sourceTag = voiceCommand ? "android-voice-command" : "android-assist";
        String prompt = extractPrompt(source);

        Uri.Builder route = Uri.parse(voiceCommand ? "elizaos://voice" : "elizaos://assistant")
                .buildUpon()
                .appendQueryParameter("source", sourceTag)
                .appendQueryParameter("action", voiceCommand ? "voice" : "ask");
        if (!TextUtils.isEmpty(prompt)) {
            route.appendQueryParameter("text", prompt);
        }
        if (voiceCommand) {
            route.appendQueryParameter("voice", "1");
        }

        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_VIEW);
        launch.setData(route.build());
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(launch);
        finish();
    }

    private static String extractPrompt(Intent source) {
        if (source == null) {
            return null;
        }

        CharSequence extraText = source.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (!TextUtils.isEmpty(extraText)) {
            return extraText.toString();
        }

        String query = source.getStringExtra(SearchManager.QUERY);
        if (!TextUtils.isEmpty(query)) {
            return query;
        }

        ArrayList<String> voiceResults = source.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (voiceResults != null) {
            for (String result : voiceResults) {
                if (!TextUtils.isEmpty(result)) {
                    return result;
                }
            }
        }

        return null;
    }
}
