package ai.elizaos.app;

/**
 * Quick Settings tile that starts a hands-free voice conversation
 * (elizaos://voice → #chat?voice=1). The android-qs-tile source is required:
 * the renderer's claim gate drops capture launches from untrusted sources, so
 * the historical android-quick-settings value left a tile that opened the app
 * but never started capture.
 */
public class ElizaVoiceTileService extends ElizaAssistantTileService {

    static final String DEEP_LINK_URI = "elizaos://voice?source=android-qs-tile";

    @Override
    protected String deepLinkUri() {
        return DEEP_LINK_URI;
    }
}
