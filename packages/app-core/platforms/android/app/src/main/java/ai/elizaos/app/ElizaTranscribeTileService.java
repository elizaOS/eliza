package ai.elizaos.app;

/**
 * Quick Settings tile that starts transcription mode — long-form record-only
 * capture (elizaos://transcribe → #chat?transcribe=1). The transcript lands in
 * the composer draft when the user stops; nothing auto-sends. Users add the
 * tile from the QS edit panel; declaration lives in AndroidManifest.xml with
 * BIND_QUICK_SETTINGS_TILE.
 */
public class ElizaTranscribeTileService extends ElizaAssistantTileService {

    static final String DEEP_LINK_URI = "elizaos://transcribe?source=android-qs-tile";

    @Override
    protected String deepLinkUri() {
        return DEEP_LINK_URI;
    }
}
