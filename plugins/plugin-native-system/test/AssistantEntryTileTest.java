package ai.eliza.plugins.system;

import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;

/** Host-JVM checks of the shared assistant entry tile against Android stand-ins (assistant-tile.test.mjs). */
public class AssistantEntryTileTest {
    static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }

    /** A host that supplies every piece of presentation, like a product's branded tile. */
    static final class FullTile extends AssistantEntryTile {
        final Icon icon = new Icon();
        @Override protected Intent entryIntent() {
            return new Intent(this, FullTile.class).setAction(Intent.ACTION_ASSIST)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        @Override protected CharSequence label() { return "Assistant"; }
        @Override protected CharSequence subtitle(boolean locked) { return locked ? "Unlock to open" : "Open assistant"; }
        @Override protected CharSequence contentDescription() { return "Open the assistant"; }
        @Override protected Icon icon() { return icon; }
        @Override protected int requestCode() { return 41; }
    }

    /** A host that keeps the manifest label and icon. */
    static final class MinimalTile extends AssistantEntryTile {
        @Override protected Intent entryIntent() { return new Intent(this, MinimalTile.class); }
    }

    public static void main(String[] args) throws Exception {
        Build.VERSION.SDK_INT = 36;

        FullTile locked = new FullTile();
        locked.locked = true;
        locked.onStartListening();
        check(locked.tile.updates == 1, "one tile update per listen");
        check(locked.tile.state == Tile.STATE_INACTIVE, "an action tile never reports an active state");
        check("Assistant".equals(locked.tile.label) && "Unlock to open".equals(locked.tile.subtitle), "locked presentation");
        check("Open the assistant".equals(locked.tile.description) && locked.tile.icon == locked.icon, "description and icon");
        locked.onClick();
        check(locked.launched == 0 && locked.unlock != null, "a locked tap waits for the owner to unlock");
        locked.locked = false;
        locked.unlock.run();
        check(locked.launched == 1, "one launch after unlock");
        check(locked.lastPending != null && locked.lastPending.intent == locked.lastIntent, "PendingIntent entry on Android 14+");
        check((locked.lastPending.flags & android.app.PendingIntent.FLAG_IMMUTABLE) != 0, "immutable PendingIntent");
        check((locked.lastPending.flags & android.app.PendingIntent.FLAG_UPDATE_CURRENT) != 0, "current entry intent");
        check(locked.lastPending.requestCode == 41, "host request code");
        check(locked.lastIntent.target == FullTile.class && Intent.ACTION_ASSIST.equals(locked.lastIntent.action), "explicit host entry");

        FullTile unlocked = new FullTile();
        unlocked.onClick();
        check(unlocked.launched == 1 && unlocked.unlock == null, "an unlocked tap opens without an unlock prompt");
        unlocked.onStartListening();
        check("Open assistant".equals(unlocked.tile.subtitle), "unlocked subtitle");

        Build.VERSION.SDK_INT = 33;
        FullTile legacy = new FullTile();
        legacy.onClick();
        check(legacy.launched == 1 && legacy.lastPending == null && legacy.lastIntent != null, "Intent entry before Android 14");
        Build.VERSION.SDK_INT = 36;
        java.lang.reflect.Method openLegacy = AssistantEntryTile.class.getDeclaredMethod("openLegacy", Intent.class);
        openLegacy.setAccessible(true);
        try {
            openLegacy.invoke(legacy, legacy.lastIntent);
            throw new AssertionError("the legacy entry was accepted on Android 14+");
        } catch (java.lang.reflect.InvocationTargetException expected) {
            check(expected.getCause() instanceof IllegalStateException, "the legacy entry fails closed on Android 14+");
        }
        check(legacy.launched == 1, "a refused legacy entry launches nothing");

        Build.VERSION.SDK_INT = 28;
        FullTile old = new FullTile();
        old.onStartListening();
        check(!old.tile.subtitleSet && old.tile.state == Tile.STATE_INACTIVE, "no subtitle before Android 10");
        Build.VERSION.SDK_INT = 36;

        MinimalTile minimal = new MinimalTile();
        minimal.tile.label = "Manifest label";
        minimal.onStartListening();
        check("Manifest label".equals(minimal.tile.label) && minimal.tile.icon == null && minimal.tile.description == null,
                "a host without presentation keeps the manifest label and icon");
        check(minimal.tile.subtitle == null && minimal.tile.state == Tile.STATE_INACTIVE, "no subtitle, inactive");
        minimal.onClick();
        check(minimal.launched == 1 && minimal.lastPending.requestCode == 0, "default request code");

        minimal.tile = null;
        minimal.onStartListening();

        ai.elizaos.app.ElizaVoiceTileService voice = new ai.elizaos.app.ElizaVoiceTileService();
        voice.locked = true;
        voice.onStartListening();
        check(voice.tile.state == Tile.STATE_INACTIVE && voice.tile.label == null, "the voice tile keeps its manifest label and is inactive");
        voice.onClick();
        check(voice.launched == 0 && voice.unlock != null, "the voice tile waits for unlock");
        voice.locked = false;
        voice.unlock.run();
        check(voice.lastIntent.target == ai.elizaos.app.MainActivity.class && Intent.ACTION_VIEW.equals(voice.lastIntent.action),
                "the voice tile opens the app's main activity");
        check("elizaos://voice?source=android-quick-settings&action=voice&voice=1".equals(String.valueOf(voice.lastIntent.data)),
                "the voice deep link");
        check(voice.lastIntent.flags == (Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                "the voice entry flags");

        System.out.println("PASS assistant entry tile");
    }
}
