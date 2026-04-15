package ai.eliza.plugins.appblocker

import android.content.Context
import android.content.SharedPreferences

data class SavedAppBlock(
    val packageNames: List<String>,
    val endsAtEpochMs: Long?,
)

object AppBlockerStateStore {

    private const val PREFS_NAME = "eliza_app_blocker"
    private const val KEY_PACKAGE_NAMES = "blocked_package_names"
    private const val KEY_ENDS_AT = "ends_at_epoch_ms"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(context: Context): SavedAppBlock? {
        val p = prefs(context)
        val names = p.getStringSet(KEY_PACKAGE_NAMES, null) ?: return null
        if (names.isEmpty()) return null

        val endsAt = if (p.contains(KEY_ENDS_AT)) p.getLong(KEY_ENDS_AT, 0L) else null

        // Auto-expire
        if (endsAt != null && endsAt <= System.currentTimeMillis()) {
            clear(context)
            return null
        }

        return SavedAppBlock(
            packageNames = names.toList().sorted(),
            endsAtEpochMs = endsAt,
        )
    }

    fun save(context: Context, packageNames: List<String>, endsAtEpochMs: Long?) {
        prefs(context).edit().apply {
            putStringSet(KEY_PACKAGE_NAMES, packageNames.toSet())
            if (endsAtEpochMs != null) {
                putLong(KEY_ENDS_AT, endsAtEpochMs)
            } else {
                remove(KEY_ENDS_AT)
            }
            apply()
        }
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }

    fun isBlocked(context: Context, packageName: String): Boolean {
        val block = load(context) ?: return false
        return block.packageNames.contains(packageName)
    }
}
