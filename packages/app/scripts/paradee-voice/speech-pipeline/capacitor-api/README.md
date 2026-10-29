Compile-only signatures of the Capacitor 8 types `LocalSpeechBridgePlugin` uses, so the host JVM
contract can compile the bridge without the Capacitor Android library and its androidx graph.
They are not Capacitor: no method here runs. The bridge also compiles in an Android build of a
host that sets `elizaSpeechBridgeCapacitor=true`.
