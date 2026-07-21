/**
 * Small Android Views renderer for the shared native transcript view model.
 * Row styling and accessibility derive only from item kind/status; text remains
 * opaque display content with first-strong bidirectional layout.
 */

package ai.elizaos.app;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

public final class NativeTranscriptView extends LinearLayout {
    public NativeTranscriptView(Context context) {
        super(context);
        setOrientation(VERTICAL);
    }

    public void render(JsonObject viewModel) {
        removeAllViews();
        for (JsonElement value : viewModel.getAsJsonArray("items")) {
            addView(row(value.getAsJsonObject()));
        }
        if (viewModel.get("connection").getAsString().equals("lost")) {
            addView(status("Connection lost", "reconnect"));
        }
        if (!viewModel.get("speaking").isJsonNull()) {
            addView(status("Eliza is speaking", "speaking"));
        }
    }

    private TextView row(JsonObject item) {
        String kind = item.get("kind").getAsString();
        String text;
        if (kind.equals("tool")) {
            text = item.get("name").getAsString() + " · " + item.get("status").getAsString();
        } else if (kind.equals("error")) {
            text = item.has("message")
                ? item.get("message").getAsString()
                : item.get("code").getAsString();
        } else if (kind.equals("reconnect")) {
            text = "Connection " + item.get("phase").getAsString();
        } else {
            text = item.get("text").getAsString();
        }

        TextView row = status(text, kind);
        row.setGravity(kind.equals("user") ? Gravity.END : Gravity.START);
        if (kind.equals("error")) row.setTextColor(Color.rgb(184, 52, 45));
        if (kind.equals("agent")) row.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return row;
    }

    private TextView status(String text, String role) {
        TextView row = new TextView(getContext());
        row.setText(text);
        row.setContentDescription(role + ": " + text);
        row.setTextDirection(View.TEXT_DIRECTION_FIRST_STRONG);
        int padding = Math.round(12 * getResources().getDisplayMetrics().density);
        row.setPadding(padding, padding / 2, padding, padding / 2);
        return row;
    }
}
