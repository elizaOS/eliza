package ai.eliza.plugins.system;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * A Quick Settings tile that opens a host app's assistant entry. It is an action, never a toggle:
 * the tile always reports {@link Tile#STATE_INACTIVE}, so its presence or colour never implies that
 * an agent, inference, a connection or the microphone is active. A tap on a locked device first asks
 * Android to unlock and opens the entry only after the owner unlocks; no tap grants a permission,
 * starts capture or carries data into the app. The host declares the service with
 * {@code android.permission.BIND_QUICK_SETTINGS_TILE} and
 * {@code android.service.quicksettings.TOGGLEABLE_TILE=false}, so only SystemUI can bind it.
 *
 * <p>Hosts subclass it and keep their installed component name (a person who added the tile keeps
 * it across updates), supplying the explicit entry intent and, optionally, presentation.
 */
@TargetApi(Build.VERSION_CODES.N)
public abstract class AssistantEntryTile extends TileService {
    /** The explicit activity intent a tap opens. Called once per tap, after any unlock. */
    protected abstract Intent entryIntent();

    /** Tile label, or null to keep the manifest label. */
    protected CharSequence label() {
        return null;
    }

    /** Subtitle for the current lock state (Android 10 and later), or null for none. */
    protected CharSequence subtitle(boolean locked) {
        return null;
    }

    /** Spoken description, or null to let Android announce the label. */
    protected CharSequence contentDescription() {
        return null;
    }

    /** Tile icon, or null to keep the manifest icon. */
    protected Icon icon() {
        return null;
    }

    /** Request code of the activity PendingIntent; distinct per tile in one app. */
    protected int requestCode() {
        return 0;
    }

    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile == null) return;
        Icon icon = icon();
        if (icon != null) tile.setIcon(icon);
        CharSequence label = label();
        if (label != null) tile.setLabel(label);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) tile.setSubtitle(subtitle(isLocked()));
        CharSequence description = contentDescription();
        if (description != null) tile.setContentDescription(description);
        tile.setState(Tile.STATE_INACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        if (isLocked()) {
            unlockAndRun(this::open);
            return;
        }
        open();
    }

    private void open() {
        Intent intent = entryIntent();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            PendingIntent pending = PendingIntent.getActivity(this, requestCode(), intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pending);
        } else {
            openLegacy(intent);
        }
    }

    /**
     * Android's Intent overload is the supported entry before Android 14, where the PendingIntent
     * overload does not exist. It is refused on 14 and later, where Android rejects it.
     */
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @SuppressWarnings("deprecation")
    private void openLegacy(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            throw new IllegalStateException("Use the PendingIntent tile entry on Android 14 and later");
        }
        startActivityAndCollapse(intent);
    }
}
