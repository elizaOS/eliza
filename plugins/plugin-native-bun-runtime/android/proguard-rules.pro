# ProGuard rules for @elizaos/capacitor-bun-runtime Android plugin.
#
# The plugin routes local-agent calls through ElizaAgentService's app-owned
# request bridge. Capacitor's standard plugin interface is the only surface
# that requires keeping here.

-keep class ai.elizaos.plugins.bunruntime.** { *; }

# Preserve Capacitor plugin method annotations so the Capacitor bridge can
# discover and dispatch to them after shrinking.
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.CapacitorPlugin <init>(...);
    @com.getcapacitor.PluginMethod public *;
}
