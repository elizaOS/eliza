package ai.elizaos.app;

import android.content.Intent;
import android.net.Uri;
import android.telecom.Call;
import android.telecom.InCallService;

public class MiladyInCallService extends InCallService {

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        openCallSurface("added", call);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        openCallSurface("removed", call);
    }

    private void openCallSurface(String event, Call call) {
        Intent intent = new Intent(this, MainActivity.class);
        Call.Details details = call.getDetails();
        Uri handle = details != null ? details.getHandle() : null;
        String displayName = details != null ? details.getCallerDisplayName() : null;
        Uri.Builder route = Uri.parse("ai.elizaos.app://phone/call").buildUpon()
                .appendQueryParameter("event", event)
                .appendQueryParameter("state", String.valueOf(call.getState()));
        if (handle != null) {
            route.appendQueryParameter("uri", handle.toString());
            route.appendQueryParameter("number", handle.getSchemeSpecificPart());
        }
        if (displayName != null && !displayName.isEmpty()) {
            route.appendQueryParameter("name", displayName);
        }
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(route.build());
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
    }
}
