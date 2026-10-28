# Resolved by GetMethodID in the synchronous PCM callback bridge.
-keepclassmembers class ai.eliza.voice.ParadeeVoice$NativeSink {
    public boolean onChunk(float[], boolean);
}
