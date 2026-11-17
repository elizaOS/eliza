package com.android.systemui.assist;

import static com.android.systemui.DejankUtils.whitelistIpcs;
import static com.android.systemui.shared.system.QuickStepContract.SYSUI_STATE_ASSIST_GESTURE_CONSTRAINED;

import android.annotation.NonNull;
import android.annotation.Nullable;
import android.app.ActivityManager;
import android.app.ActivityOptions;
import android.app.SearchManager;
import android.app.StatusBarManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.metrics.LogMaker;
import android.os.AsyncTask;
import android.os.Bundle;
import android.os.Handler;
import android.os.RemoteException;
import android.os.SystemClock;
import android.os.UserHandle;
import android.provider.Settings;
import android.service.voice.VisualQueryAttentionResult;
import android.service.voice.VoiceInteractionSession;
import android.util.Log;
import android.view.WindowManager;

import com.android.internal.app.AssistUtils;
import com.android.internal.app.IVisualQueryDetectionAttentionListener;
import com.android.internal.app.IVisualQueryRecognitionStatusListener;
import com.android.internal.app.IVoiceInteractionSessionListener;
import com.android.internal.logging.MetricsLogger;
import com.android.internal.logging.nano.MetricsProto.MetricsEvent;
import com.android.systemui.LauncherProxyService;
import com.android.systemui.assist.domain.interactor.AssistInteractor;
import com.android.systemui.assist.ui.DefaultUiController;
import com.android.systemui.dagger.SysUISingleton;
import com.android.systemui.dagger.qualifiers.Background;
import com.android.systemui.dagger.qualifiers.Main;
import com.android.systemui.model.SysUiState;
import com.android.systemui.res.R;
import com.android.systemui.settings.DisplayTracker;
import com.android.systemui.settings.UserTracker;
import com.android.systemui.statusbar.CommandQueue;
import com.android.systemui.statusbar.policy.DeviceProvisionedController;
import com.android.systemui.topwindoweffects.data.repository.InvocationEffectEnabler;
import com.android.systemui.user.domain.interactor.SelectedUserInteractor;
import com.android.systemui.util.settings.SecureSettings;

import dagger.Lazy;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

import javax.inject.Inject;

/**
 * Class to manage everything related to assist in SystemUI.
 */
@SysUISingleton
public class AssistManager {

    /**
     * Controls the UI for showing Assistant invocation progress.
     */
    public interface UiController {
        /**
         * Updates the invocation progress.
         *
         * @param type     one of INVOCATION_TYPE_GESTURE, INVOCATION_TYPE_ACTIVE_EDGE,
         *                 INVOCATION_TYPE_VOICE, INVOCATION_TYPE_QUICK_SEARCH_BAR,
         *                 INVOCATION_TYPE_HOME_BUTTON_LONG_PRESS
         * @param progress a float between 0 and 1 inclusive. 0 represents the beginning of the
         *                 gesture; 1 represents the end.
         */
        void onInvocationProgress(int type, float progress);

        /**
         * Called when an invocation gesture completes.
         *
         * @param velocity the speed of the invocation gesture, in pixels per millisecond. For
         *                 drags, this is 0.
         */
        void onGestureCompletion(float velocity);

        /**
         * Hides any SysUI for the assistant, but _does not_ close the assistant itself.
         */
        void hide();
    }

    /**
     * An interface for a listener that receives notification that visual query attention has
     * either been gained or lost.
     */
    public interface VisualQueryAttentionListener {
        /** Called when visual query attention has been gained. */
        void onAttentionGained();

        /** Called when visual query attention has been lost. */
        void onAttentionLost();
    }

    private static final String TAG = "AssistManager";

    // Note that VERBOSE logging may leak PII (e.g. transcription contents).
    private static final boolean VERBOSE = false;

    private static final String INVOCATION_TIME_MS_KEY = "invocation_time_ms";
    private static final String INVOCATION_PHONE_STATE_KEY = "invocation_phone_state";
    public static final String ACTION_KEY = "action";
    protected static final String SET_ASSIST_GESTURE_CONSTRAINED_ACTION =
            "set_assist_gesture_constrained";
    protected static final String CONSTRAINED_KEY = "should_constrain";

    public static final String INVOCATION_TYPE_KEY = "invocation_type";
    public static final int INVOCATION_TYPE_UNKNOWN =
            AssistUtils.INVOCATION_TYPE_UNKNOWN;
    public static final int INVOCATION_TYPE_GESTURE =
            AssistUtils.INVOCATION_TYPE_GESTURE;
    public static final int INVOCATION_TYPE_OTHER =
            AssistUtils.INVOCATION_TYPE_PHYSICAL_GESTURE;
    public static final int INVOCATION_TYPE_VOICE =
            AssistUtils.INVOCATION_TYPE_VOICE;
    public static final int INVOCATION_TYPE_QUICK_SEARCH_BAR =
            AssistUtils.INVOCATION_TYPE_QUICK_SEARCH_BAR;
    public static final int INVOCATION_TYPE_HOME_BUTTON_LONG_PRESS =
            AssistUtils.INVOCATION_TYPE_HOME_BUTTON_LONG_PRESS;
    public static final int INVOCATION_TYPE_POWER_BUTTON_LONG_PRESS =
            AssistUtils.INVOCATION_TYPE_POWER_BUTTON_LONG_PRESS;
    public static final int INVOCATION_TYPE_NAV_HANDLE_LONG_PRESS =
            AssistUtils.INVOCATION_TYPE_NAV_HANDLE_LONG_PRESS;
    public static final int INVOCATION_TYPE_LAUNCHER_SYSTEM_SHORTCUT =
            AssistUtils.INVOCATION_TYPE_LAUNCHER_SYSTEM_SHORTCUT;
    public static final int INVOCATION_TYPE_STATUS_BAR_ICON =
            AssistUtils.INVOCATION_TYPE_STATUS_BAR_ICON;

    public static final int DISMISS_REASON_INVOCATION_CANCELLED = 1;
    public static final int DISMISS_REASON_TAP = 2;
    public static final int DISMISS_REASON_BACK = 3;
    public static final int DISMISS_REASON_TIMEOUT = 4;

    private static final long TIMEOUT_SERVICE = 2500;
    private static final long TIMEOUT_ACTIVITY = 1000;

    protected final Context mContext;
    private final AssistDisclosure mAssistDisclosure;
    private final PhoneStateMonitor mPhoneStateMonitor;
    private final LauncherProxyService mLauncherProxyService;
    private final UiController mUiController;
    protected final Lazy<SysUiState> mSysUiState;
    protected final AssistLogger mAssistLogger;
    private final UserTracker mUserTracker;
    private final DisplayTracker mDisplayTracker;
    private final SecureSettings mSecureSettings;
    private final SelectedUserInteractor mSelectedUserInteractor;
    private final ActivityManager mActivityManager;
    private final AssistInteractor mInteractor;
    private final Handler mBgHandler;
    private final Optional<InvocationEffectEnabler> mOptionalInvocationEffectEnabler;

    private final DeviceProvisionedController mDeviceProvisionedController;

    private final List<VisualQueryAttentionListener> mVisualQueryAttentionListeners =
            new ArrayList<>();

    private final IVisualQueryDetectionAttentionListener mVisualQueryDetectionAttentionListener =
            new IVisualQueryDetectionAttentionListener.Stub() {
                @Override
                public void onAttentionGained(VisualQueryAttentionResult attentionResult) {
                    // TODO (b/319132184): Implemented this with different types.
                    handleVisualAttentionChanged(true);
                }

                @Override
                public void onAttentionLost(int interactionIntention) {
                    //TODO (b/319132184): Implemented this with different types.
                    handleVisualAttentionChanged(false);
                }
            };

    private final CommandQueue mCommandQueue;
    protected final AssistUtils mAssistUtils;

    // Invocation types that should be sent over LauncherProxy instead of handled here.
    private int[] mAssistOverrideInvocationTypes;

    @Inject
    public AssistManager(
            DeviceProvisionedController controller,
            Context context,
            AssistUtils assistUtils,
            CommandQueue commandQueue,
            PhoneStateMonitor phoneStateMonitor,
            LauncherProxyService launcherProxyService,
            Lazy<SysUiState> sysUiState,
            DefaultUiController defaultUiController,
            AssistLogger assistLogger,
            @Main Handler uiHandler,
            @Background Handler bgHandler,
            UserTracker userTracker,
            DisplayTracker displayTracker,
            SecureSettings secureSettings,
            SelectedUserInteractor selectedUserInteractor,
            ActivityManager activityManager,
            AssistInteractor interactor,
            WindowManager windowManager,
            Optional<InvocationEffectEnabler> optionalInvocationEffectEnabler) {
        mContext = context;
        mDeviceProvisionedController = controller;
        mCommandQueue = commandQueue;
        mAssistUtils = assistUtils;
        mAssistDisclosure = new AssistDisclosure(context, uiHandler, windowManager);
        mLauncherProxyService = launcherProxyService;
        mPhoneStateMonitor = phoneStateMonitor;
        mAssistLogger = assistLogger;
        mUserTracker = userTracker;
        mDisplayTracker = displayTracker;
        mSecureSettings = secureSettings;
        mSelectedUserInteractor = selectedUserInteractor;
        mActivityManager = activityManager;
        mInteractor = interactor;
        mBgHandler = bgHandler;
        mOptionalInvocationEffectEnabler = optionalInvocationEffectEnabler;

        registerVoiceInteractionSessionListener();
        registerVisualQueryRecognitionStatusListener();

        mUiController = defaultUiController;

        mSysUiState = sysUiState;

        mLauncherProxyService.addCallback(new LauncherProxyService.LauncherProxyListener() {
            @Override
            public void onAssistantProgress(float progress) {
                // Progress goes from 0 to 1 to indicate how close the assist gesture is to
                // completion.
                onInvocationProgress(INVOCATION_TYPE_GESTURE, progress);
            }

            @Override
            public void onAssistantGestureCompletion(float velocity) {
                onGestureCompletion(velocity);
            }
        });
    }

    protected void registerVoiceInteractionSessionListener() {
        mAssistUtils.registerVoiceInteractionSessionListener(
                new IVoiceInteractionSessionListener.Stub() {
                    @Override
                    public void onVoiceSessionShown() throws RemoteException {
                        if (VERBOSE) {
                            Log.v(TAG, "Voice open");
                        }
                        mAssistLogger.reportAssistantSessionEvent(
                                AssistantSessionEvent.ASSISTANT_SESSION_UPDATE);
                    }

                    @Override
                    public void onVoiceSessionHidden() throws RemoteException {
                        if (VERBOSE) {
                            Log.v(TAG, "Voice closed");
                        }
                        mAssistLogger.reportAssistantSessionEvent(
                                AssistantSessionEvent.ASSISTANT_SESSION_CLOSE);
                    }

                    @Override
                    public void onVoiceSessionWindowVisibilityChanged(boolean visible)
                            throws RemoteException {
                        if (VERBOSE) {
                            Log.v(TAG, "Window visibility changed: " + visible);
                        }
                    }

                    @Override
                    public void onSetUiHints(Bundle hints) {
                        if (VERBOSE) {
                            Log.v(TAG, "UI hints received");
                        }

                        String action = hints.getString(ACTION_KEY);
                        if (SET_ASSIST_GESTURE_CONSTRAINED_ACTION.equals(action)) {
                            mSysUiState.get()
                                    .setFlag(
                                            SYSUI_STATE_ASSIST_GESTURE_CONSTRAINED,
                                            hints.getBoolean(CONSTRAINED_KEY, false))
                                    .commitUpdate(mDisplayTracker.getDefaultDisplayId());
                        }
                    }

                    @Override
                    public void onSetInvocationEffectEnabled(boolean enabled) {
                        if (VERBOSE) {
                            Log.v(TAG, "Set invocation effect enabled received");
                        }
                        mOptionalInvocationEffectEnabler.ifPresent(
                                effectEnabler -> effectEnabler.setEnabled(enabled));
                    }
                });
    }

    public void startAssist(Bundle args) {
        startAssist(mContext, args);
    }

    /**
     * Same as {@link #startAssist(Bundle)}, but with an option to pass a specific {@link Context}
     * to be used when launching Assistant.
     *
     * <p>An example usage could be a display specific {@link Context}, to that Assistant is
     * launched on that specific display.
     */
    public void startAssist(Context context, Bundle args) {
        if (mActivityManager.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE) {
            return;
        }
        if (shouldOverrideAssist(args)) {
            try {
                if (mLauncherProxyService.getProxy() == null) {
                    Log.w(TAG, "No LauncherProxyService to invoke assistant override");
                    return;
                }
                mLauncherProxyService.getProxy().onAssistantOverrideInvoked(
                        args.getInt(INVOCATION_TYPE_KEY));
            } catch (RemoteException e) {
                Log.w(TAG, "Unable to invoke assistant via LauncherProxyService override", e);
            }
            return;
        }

        final ComponentName assistComponent = getAssistInfo();
        if (assistComponent == null) {
            return;
        }

        final boolean isService = assistComponent.equals(getVoiceInteractorComponentName());

        if (args == null) {
            args = new Bundle();
        }
        int legacyInvocationType = args.getInt(INVOCATION_TYPE_KEY, 0);
        int legacyDeviceState = mPhoneStateMonitor.getPhoneState();
        args.putInt(INVOCATION_PHONE_STATE_KEY, legacyDeviceState);
        args.putLong(INVOCATION_TIME_MS_KEY, SystemClock.elapsedRealtime());
        mAssistLogger.reportAssistantInvocationEventFromLegacy(
                legacyInvocationType,
                /* isInvocationComplete = */ true,
                assistComponent,
                legacyDeviceState);
        logStartAssistLegacy(legacyInvocationType, legacyDeviceState);
        mInteractor.onAssistantStarted(legacyInvocationType);
        startAssistInternal(context, args, assistComponent, isService);
    }

    private boolean shouldOverrideAssist(Bundle args) {
        if (args == null || !args.containsKey(INVOCATION_TYPE_KEY)) {
            return false;
        }

        int invocationType = args.getInt(INVOCATION_TYPE_KEY);
        return shouldOverrideAssist(invocationType);
    }

    /** @return true if the invocation type should be handled by LauncherProxy instead of SysUI. */
    public boolean shouldOverrideAssist(int invocationType) {
        return mAssistOverrideInvocationTypes != null
                && Arrays.stream(mAssistOverrideInvocationTypes).anyMatch(
                    override -> override == invocationType);
    }

    /**
     * @param invocationTypes The invocation types that will henceforth be handled via
     *                        LauncherProxy (Launcher); other invocation types should be handled by
     *                        this class.
     */
    public void setAssistantOverridesRequested(int[] invocationTypes) {
        mAssistOverrideInvocationTypes = invocationTypes;
    }

    /** Called when the user is performing an assistant invocation action (e.g. Active Edge) */
    public void onInvocationProgress(int type, float progress) {
        mUiController.onInvocationProgress(type, progress);
    }

    /**
     * Called when the user has invoked the assistant with the incoming velocity, in pixels per
     * millisecond. For invocations without a velocity (e.g. slow drag), the velocity is set to
     * zero.
     */
    public void onGestureCompletion(float velocity) {
        mUiController.onGestureCompletion(velocity);
    }

    public void hideAssist() {
        mAssistUtils.hideCurrentSession();
    }

    /**
     * Add the given {@link VisualQueryAttentionListener} to the list of listeners awaiting
     * notification of gaining/losing visual query attention.
     */
    public void addVisualQueryAttentionListener(VisualQueryAttentionListener listener) {
        if (!mVisualQueryAttentionListeners.contains(listener)) {
            mVisualQueryAttentionListeners.add(listener);
        }
    }

    /**
     * Remove the given {@link VisualQueryAttentionListener} from the list of listeners awaiting
     * notification of gaining/losing visual query attention.
     */
    public void removeVisualQueryAttentionListener(VisualQueryAttentionListener listener) {
        mVisualQueryAttentionListeners.remove(listener);
    }

    private void startAssistInternal(
            Context context,
            Bundle args,
            @NonNull ComponentName assistComponent,
            boolean isService) {
        if (isService) {
            startVoiceInteractor(context, args);
        } else {
            startAssistActivity(context, args, assistComponent);
        }
    }

    private void startAssistActivity(
            Context context, Bundle args, @NonNull ComponentName assistComponent) {
        if (!mDeviceProvisionedController.isDeviceProvisioned()) {
            return;
        }

        // Close Recent Apps if needed
        mCommandQueue.animateCollapsePanels(
                CommandQueue.FLAG_EXCLUDE_SEARCH_PANEL | CommandQueue.FLAG_EXCLUDE_RECENTS_PANEL,
                false /* force */);

        boolean structureEnabled = mSecureSettings.getIntForUser(
                Settings.Secure.ASSIST_STRUCTURE_ENABLED, 1, UserHandle.USER_CURRENT) != 0;

        final SearchManager searchManager =
                (SearchManager) context.getSystemService(Context.SEARCH_SERVICE);
        if (searchManager == null) {
            return;
        }
        final Intent intent = searchManager.getAssistIntent(structureEnabled);
        if (intent == null) {
            return;
        }
        intent.setComponent(assistComponent);
        intent.putExtras(args);

        if (!android.permission.flags.Flags.assistSettingsPrivacyImprovementsEnabled()
                && structureEnabled && AssistUtils.isDisclosureEnabled(context)) {
            showDisclosure();
        }

        try {
            final ActivityOptions opts = ActivityOptions.makeCustomAnimation(context,
                    R.anim.search_launch_enter, R.anim.search_launch_exit);
            opts.setLaunchDisplayId(context.getDisplayId());

            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            AsyncTask.execute(new Runnable() {
                @Override
                public void run() {
                    context.startActivityAsUser(intent, opts.toBundle(),
                            mUserTracker.getUserHandle());
                }
            });
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "Activity not found for " + intent.getAction());
        }
    }

    private void startVoiceInteractor(Context context, Bundle args) {
        if (!args.containsKey(Intent.EXTRA_ASSIST_DISPLAY_ID)) {
            // If a display id was not explicitly specified, let's use the display associated with
            // the Context.
            args.putInt(Intent.EXTRA_ASSIST_DISPLAY_ID, context.getDisplayId());
        }
        // Use background thread to prevent the binder call from blocking the UI thread
        mBgHandler.post(() -> mAssistUtils.showSessionForActiveService(args,
                VoiceInteractionSession.SHOW_SOURCE_ASSIST_GESTURE,
                context.getAttributionTag(), null, null));
    }

    private void registerVisualQueryRecognitionStatusListener() {
        if (!mContext.getResources()
                .getBoolean(R.bool.config_enableVisualQueryAttentionDetection)) {
            return;
        }

        mAssistUtils.subscribeVisualQueryRecognitionStatus(
                new IVisualQueryRecognitionStatusListener.Stub() {
                    @Override
                    public void onStartPerceiving() {
                        mAssistUtils.enableVisualQueryDetection(
                                mVisualQueryDetectionAttentionListener);
                        final StatusBarManager statusBarManager =
                                mContext.getSystemService(StatusBarManager.class);
                        if (statusBarManager != null) {
                            statusBarManager.setIcon("assist_attention",
                                    R.drawable.ic_assistant_attention_indicator,
                                    0, "Attention Icon for Assistant");
                            statusBarManager.setIconVisibility("assist_attention", false);
                        }
                    }

                    @Override
                    public void onStopPerceiving() {
                        // Treat this as a signal that attention has been lost (and inform listeners
                        // accordingly).
                        handleVisualAttentionChanged(false);
                        mAssistUtils.disableVisualQueryDetection();
                        final StatusBarManager statusBarManager =
                                mContext.getSystemService(StatusBarManager.class);
                        if (statusBarManager != null) {
                            statusBarManager.removeIcon("assist_attention");
                        }
                    }
                });
    }

    // TODO (b/319132184): Implemented this with different types.
    private void handleVisualAttentionChanged(boolean attentionGained) {
        final StatusBarManager statusBarManager = mContext.getSystemService(StatusBarManager.class);
        if (statusBarManager != null) {
            statusBarManager.setIconVisibility("assist_attention", attentionGained);
        }
        mVisualQueryAttentionListeners.forEach(
                attentionGained
                        ? VisualQueryAttentionListener::onAttentionGained
                        : VisualQueryAttentionListener::onAttentionLost);
    }

    public void launchVoiceAssistFromKeyguard() {
        mAssistUtils.launchVoiceAssistFromKeyguard();
    }

    public boolean canVoiceAssistBeLaunchedFromKeyguard() {
        // TODO(b/140051519)
        return whitelistIpcs(() -> mAssistUtils.activeServiceSupportsLaunchFromKeyguard());
    }

    public ComponentName getVoiceInteractorComponentName() {
        return mAssistUtils.getActiveServiceComponentName();
    }

    private boolean isVoiceSessionRunning() {
        return mAssistUtils.isSessionRunning();
    }

    @Nullable
    public ComponentName getAssistInfoForUser(int userId) {
        return mAssistUtils.getAssistComponentForUser(userId);
    }

    @Nullable
    public ComponentName getAssistInfo() {
        return getAssistInfoForUser(mSelectedUserInteractor.getSelectedUserId());
    }

    public void showDisclosure() {
        mAssistDisclosure.postShow();
    }

    public void onLockscreenShown() {
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                mAssistUtils.onLockscreenShown();
            }
        });
    }

    /** Returns the logging flags for the given Assistant invocation type. */
    public int toLoggingSubType(int invocationType) {
        return toLoggingSubType(invocationType, mPhoneStateMonitor.getPhoneState());
    }

    protected void logStartAssistLegacy(int invocationType, int phoneState) {
        MetricsLogger.action(
                new LogMaker(MetricsEvent.ASSISTANT)
                        .setType(MetricsEvent.TYPE_OPEN)
                        .setSubtype(toLoggingSubType(invocationType, phoneState)));
    }

    protected final int toLoggingSubType(int invocationType, int phoneState) {
        // Note that this logic will break if the number of Assistant invocation types exceeds 7.
        // There are currently 5 invocation types, but we will be migrating to the new logging
        // framework in the next update.
        int subType = 0;
        subType |= invocationType << 1;
        subType |= phoneState << 4;
        return subType;
    }
}
