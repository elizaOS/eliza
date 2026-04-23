package ai.elizaos.app;

import android.content.Intent;
import android.telecom.Call;
import android.telecom.InCallService;

public class MiladyInCallService extends InCallService {

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        openCallSurface("added");
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        openCallSurface("removed");
    }

    private void openCallSurface(String event) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("milady.route", "/phone/call");
        intent.putExtra("milady.call.event", event);
        startActivity(intent);
    }
}
