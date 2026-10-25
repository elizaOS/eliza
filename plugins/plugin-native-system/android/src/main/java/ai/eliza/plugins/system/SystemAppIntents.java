package ai.eliza.plugins.system;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.provider.MediaStore;
import android.provider.Telephony;

/** Common user-requested app destinations. The host owns foreground/user consent policy. */
public final class SystemAppIntents {
    private SystemAppIntents() {}

    public interface Launcher {
        void launch(Intent intent);
    }

    public static Intent phone() {
        return new Intent(Intent.ACTION_DIAL);
    }

    public static Intent messages(Context context) {
        String name = Telephony.Sms.getDefaultSmsPackage(context);
        Intent intent = name == null ? null : context.getPackageManager().getLaunchIntentForPackage(name);
        return intent == null
            ? Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_MESSAGING)
            : intent;
    }

    public enum PhotoStatus { DISPATCHED, UNAVAILABLE, DENIED }

    public static final class PhotoResult {
        public final PhotoStatus status;
        public final RuntimeException error;

        private PhotoResult(PhotoStatus status, RuntimeException error) {
            this.status = status;
            this.error = error;
        }
    }

    /** Fall back to the image viewer only when no gallery exists, never on gallery denial. */
    public static PhotoResult openPhotos(Launcher launcher) {
        try {
            launcher.launch(Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_GALLERY));
            return new PhotoResult(PhotoStatus.DISPATCHED, null);
        } catch (ActivityNotFoundException absent) {
            try {
                launcher.launch(new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*"));
                return new PhotoResult(PhotoStatus.DISPATCHED, null);
            } catch (ActivityNotFoundException | SecurityException unavailable) {
                return new PhotoResult(PhotoStatus.UNAVAILABLE, unavailable);
            }
        } catch (SecurityException denied) {
            return new PhotoResult(PhotoStatus.DENIED, denied);
        }
    }
}
