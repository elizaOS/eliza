/** Exposes Android's metered flag for the active network to Capacitor (spec/os/android/networkPolicy.md). */
package ai.eliza.plugins.networkpolicy

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Network cost bridge for a large download such as a voice model update.
 *
 * `getMeteredHint` answers `{ metered: true | false | null, source: "android-os" }`
 * from `NET_CAPABILITY_NOT_METERED` of the active network; `null` is unknown,
 * which the caller treats as "ask first".
 *
 * A host may register a subclass to limit the bridge: [enabled] is checked by
 * every method. Capacitor does not inherit the annotation, so the subclass
 * declares its own `@CapacitorPlugin` with a name.
 */
@CapacitorPlugin(name = "ElizaNetworkPolicy")
open class NetworkPolicyPlugin : Plugin() {
    /** Whether this build exposes the network cost bridge. */
    protected open fun enabled(): Boolean = true

    private fun admitted(call: PluginCall): Boolean {
        if (enabled()) return true
        call.reject("Network policy is turned off in this app", "DISABLED")
        return false
    }

    @PluginMethod
    fun getMeteredHint(call: PluginCall) {
        if (admitted(call)) call.resolve(NetworkPolicyReader.readMeteredHint(context))
    }
}
