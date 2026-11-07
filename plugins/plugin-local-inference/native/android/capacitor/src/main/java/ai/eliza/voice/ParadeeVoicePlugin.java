package ai.eliza.voice;

import com.getcapacitor.annotation.CapacitorPlugin;

/** Legacy bridge name. All requests use ElizaInference's process-owned session. */
@Deprecated
@CapacitorPlugin(name = "ParadeeVoice")
public final class ParadeeVoicePlugin extends ElizaInferencePlugin {}
