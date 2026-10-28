# Android inference compatibility entry point

The implementation and model pins now live in
[plugin-local-inference](../../../../../plugins/plugin-local-inference/native/android/README.md).
Existing consumers can continue to apply this directory's `consumer.gradle`.
It forwards to that implementation and reuses an existing generated native bundle.
New consumers should use the plugin path.
