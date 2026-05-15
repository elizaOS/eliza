package ai.elizaos.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.os.Build;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

public class ElizaAccessibilityService extends AccessibilityService {

    private static final String TAG = "ElizaAccessibility";
    private static volatile ElizaAccessibilityService instance;

    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 100;
        info.flags =
            AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
            AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        }
        setServiceInfo(info);
        Log.i(TAG, "Accessibility bridge connected.");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        Log.d(TAG, "Accessibility event: " + event.getEventType());
    }

    @Override
    public void onInterrupt() {
        Log.i(TAG, "Accessibility bridge interrupted.");
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }
}
