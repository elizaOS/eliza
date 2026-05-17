package ai.eliza.plugins.appblocker

import android.content.Context

data class SavedAppBlock(
    val packageNames: List<String>,
    val endsAtEpochMs: Long?,
)

object AppBlockerStateStore {
    private const val PREFS_NAME = "eliza_app_blocker"
    private const val KEY_PACKAGE_NAMES = "blocked_package_names"
    private const val KEY_ENDS_AT = "ends_at_epoch_ms"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(context: Context): SavedAppBlock? {
        val preferences = prefs(context)
        val packageNames = preferences.getStringSet(KEY_PACKAGE_NAMES, null)
            ?.toList()
            ?.sorted()
            ?: return null
        if (packageNames.isEmpty()) {
            return null
        }

        val endsAtEpochMs = if (preferences.contains(KEY_ENDS_AT)) {
            preferences.getLong(KEY_ENDS_AT, 0L)
        } else {
            null
        }

        if (endsAtEpochMs != null && endsAtEpochMs <= System.currentTimeMillis()) {
            clear(context)
            return null
        }

        return SavedAppBlock(
            packageNames = packageNames,
            endsAtEpochMs = endsAtEpochMs,
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
        val saved = load(context) ?: return false
        return saved.packageNames.contains(packageName)
    }
}
