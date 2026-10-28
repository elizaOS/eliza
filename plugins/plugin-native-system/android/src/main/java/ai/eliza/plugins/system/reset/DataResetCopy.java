package ai.eliza.plugins.system.reset;

/**
 * Text for the native reset disclosure, progress, results and recovery screen. Defaults name the
 * product and describe only what {@link DataReset} does: a package-scoped clear of this app's local
 * data, never device-wide media, other apps, remote account data or a subscription. A host replaces
 * the disclosure when it must list product-specific data or remote steps.
 */
public final class DataResetCopy {
    public final String reviewTitle;
    public final String disclosure;
    public final String cancelLabel;
    public final String continueLabel;
    public final String credentialTitle;
    public final String credentialDescription;
    public final String progressTitle;
    public final String progressMessage;
    public final String reviewClosed;
    public final String reviewBusy;
    public final String nothingReset;
    public final String reviewExpired;
    public final String noScreenLock;
    public final String authenticationUnavailable;
    public final String authenticationCancelled;
    public final String prepareFailed;
    public final String recoveryTitle;
    public final String recoveryIntro;
    public final String reasonAndroid;
    public final String reasonListenerPending;
    public final String reasonListenerUnreachable;
    public final String closedNote;
    public final String listenerHint;
    public final String availableNote;
    public final String retryLabel;
    public final String listenerSettingsLabel;
    public final String phoneLabel;
    public final String androidSettingsLabel;
    public final String retrying;
    public final String dispatched;
    public final String androidRefused;
    public final String listenerPending;
    public final String listenerUnreachable;
    public final String screenUnavailable;

    private DataResetCopy(Builder b) {
        String p = b.product;
        reviewTitle = "Reset " + p + " data?";
        disclosure = b.disclosure != null ? b.disclosure
                : "Permanently delete " + p + "'s local data on this phone, including conversations, settings, saved sign-ins and files in its private storage, and stop its agent and pending work. There is no backup or undo.\n\n"
                + "Device-wide photos and files, remote account data and subscriptions are not deleted or cancelled. Other apps are not reset. "
                + p + " will close; open it again to start fresh.\n\nConfirm, then unlock your device to continue.";
        cancelLabel = "Cancel";
        continueLabel = "Continue to unlock";
        credentialTitle = "Reset " + p + " data";
        credentialDescription = "Unlock to permanently erase " + p + "'s local data.";
        progressTitle = "Resetting " + p;
        progressMessage = b.progressMessage != null ? b.progressMessage : p + " closes in a few seconds.";
        reviewClosed = "Reset review closed. Nothing reset.";
        reviewBusy = "A reset review is already open.";
        nothingReset = "Nothing reset.";
        reviewExpired = "Reset review expired. Nothing reset.";
        noScreenLock = "Set a device screen lock in Android before resetting " + p + " data.";
        authenticationUnavailable = "Device authentication is unavailable. Nothing reset.";
        authenticationCancelled = "Reset cancelled. Nothing reset.";
        prepareFailed = "Reset could not be prepared. Close and reopen " + p + " before trying again.";
        recoveryTitle = "Reset could not finish";
        recoveryIntro = "You confirmed Reset " + p + " data, but the reset has not finished. " + p + "'s local data has not been deleted yet."
                + (b.recoveryRemoteNote != null ? " " + b.recoveryRemoteNote : "") + "\n\n";
        reasonAndroid = "Android has not accepted " + p + "'s request to delete its data. ";
        reasonListenerPending = p + " deletes its data only after the phone's always-on listener confirms that its consent has been withdrawn, and that confirmation has not arrived. ";
        reasonListenerUnreachable = p + " deletes its data only after the phone's always-on listener confirms that its consent has been withdrawn. "
                + p + " cannot reach the listener's controls on this phone, so it cannot get that confirmation, and trying again will not finish the reset until the listener is repaired. ";
        closedNote = "Until the reset finishes, " + p + " stays closed: its agent, notifications and scheduled work do not run.\n\n";
        listenerHint = "Try again, or open the listener's settings to turn it off first. ";
        availableNote = "Phone and Android Settings remain available.";
        retryLabel = "Try reset again";
        listenerSettingsLabel = "Open listener settings";
        phoneLabel = "Phone";
        androidSettingsLabel = "Android Settings";
        retrying = "Trying the reset again…";
        dispatched = "Android is deleting " + p + "'s data. " + p + " will close.";
        androidRefused = "Android did not accept the reset. " + p + "'s local data was not deleted. Try again.";
        listenerPending = "The listener still has not confirmed. " + p + "'s local data was not deleted. Open its settings to turn it off, then try again.";
        listenerUnreachable = "The listener could not be reached. " + p + "'s local data was not deleted.";
        screenUnavailable = "That screen is not available on this phone.";
    }

    /**
     * The recovery explanation; never claims deletion happened. The reason is the last failed
     * attempt's outcome ({@link DataReset#lastFailure}); only when none is recorded is it inferred
     * from the listener state.
     */
    public String recoveryBody(DataReset.Outcome lastFailure, boolean listenerInstalled, boolean listenerControllable) {
        boolean listenerReason = lastFailure == DataReset.Outcome.LISTENER_UNACKNOWLEDGED
                || (lastFailure != DataReset.Outcome.ANDROID_REFUSED && listenerInstalled);
        return recoveryIntro
                + (!listenerReason ? reasonAndroid : listenerControllable ? reasonListenerPending : reasonListenerUnreachable)
                + closedNote + (listenerReason && listenerControllable ? listenerHint : "") + availableNote;
    }

    /** Status after a recovery retry that Android did not dispatch. */
    public String retryResult(DataReset.Outcome outcome, boolean listenerControllable) {
        if (outcome == DataReset.Outcome.DISPATCHED) return dispatched;
        if (outcome != DataReset.Outcome.LISTENER_UNACKNOWLEDGED) return androidRefused;
        return listenerControllable ? listenerPending : listenerUnreachable;
    }

    /** @param product the name people see for the app, for example its launcher label */
    public static Builder forProduct(String product) {
        return new Builder(product);
    }

    public static final class Builder {
        private final String product;
        private String disclosure;
        private String progressMessage;
        private String recoveryRemoteNote;

        private Builder(String product) {
            if (product == null || product.trim().isEmpty() || product.length() > 60) throw new IllegalArgumentException("Invalid product name");
            this.product = product.trim();
        }

        /** Replaces the default disclosure; it must keep the no-backup, no-undo and scope statements. */
        public Builder disclosure(String text) {
            disclosure = text;
            return this;
        }

        /** Shown while {@link DataReset.BeforeDispatch} runs, for example a remote sign-out. */
        public Builder progressMessage(String text) {
            progressMessage = text;
            return this;
        }

        /** Added to the recovery explanation when a remote step may already have happened. */
        public Builder recoveryRemoteNote(String text) {
            recoveryRemoteNote = text;
            return this;
        }

        public DataResetCopy build() {
            return new DataResetCopy(this);
        }
    }
}
