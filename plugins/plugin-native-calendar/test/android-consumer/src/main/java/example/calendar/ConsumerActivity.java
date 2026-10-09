package example.calendar;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public final class ConsumerActivity extends BridgeActivity {
 @Override public void onCreate(Bundle savedInstanceState){registerPlugin(ConsumerCalendar.class);super.onCreate(savedInstanceState);}
}
