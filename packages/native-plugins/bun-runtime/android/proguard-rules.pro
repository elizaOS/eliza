# ProGuard rules for @elizaos/capacitor-bun-runtime Android plugin.
#
# The plugin communicates exclusively via loopback HTTP to the ElizaAgentService
# at 127.0.0.1:31337. No reflection-sensitive serialization is used; only
# Capacitor's standard plugin interface requires keeping.

-keep class ai.elizaos.plugins.bunruntime.** { *; }

# Preserve Capacitor plugin method annotations so the Capacitor bridge can
# discover and dispatch to them after shrinking.
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.CapacitorPlugin <init>(...);
    @com.getcapacitor.PluginMethod public *;
}
