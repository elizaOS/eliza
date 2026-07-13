package ai.elizaos.app;

/**
 * Quick Settings tile that opens the Eliza chat surface. No capture flag: the
 * deep link routes to #chat and the shell opens the conversation, keyboard
 * ready. Users add the tile from the QS edit panel; declaration lives in
 * AndroidManifest.xml with BIND_QUICK_SETTINGS_TILE.
 */
public class ElizaChatTileService extends ElizaAssistantTileService {

    static final String DEEP_LINK_URI = "elizaos://chat?source=android-qs-tile";

    @Override
    protected String deepLinkUri() {
        return DEEP_LINK_URI;
    }
}
