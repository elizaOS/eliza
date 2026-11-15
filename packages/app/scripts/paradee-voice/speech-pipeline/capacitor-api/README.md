Compile-only signatures of the Capacitor 8 types `LocalSpeechBridgePlugin` and `ElizaInferencePlugin`
use, so the host JVM contract can compile the bridges without the Capacitor Android library and its
androidx graph. They are not Capacitor: no method here runs. The bridges also compile in an Android
build of a host that sets `elizaSpeechBridgeCapacitor=true` or `elizaInferenceCapacitor=true`.
