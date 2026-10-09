package example.reminders.fixture;
import android.os.Bundle;
public final class BridgeActivity extends com.getcapacitor.BridgeActivity {
 @Override public void onCreate(Bundle savedInstanceState){registerPlugin(BridgeReminder.class);super.onCreate(savedInstanceState);}
}
