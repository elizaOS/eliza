package ai.eliza.plugins.websiteblocker

import android.content.Context

data class SavedWebsiteBlock(
    val websites: List<String>,
    val endsAtEpochMs: Long?,
)

object WebsiteBlockerStateStore {
    private const val PREFS_NAME = "eliza_website_blocker"
    private const val KEY_WEBSITES = "websites"
    private const val KEY_ENDS_AT = "ends_at_epoch_ms"

    fun normalizeHostname(value: String): String? {
        val trimmed = value.trim().trim('.').lowercase()
        if (trimmed.isEmpty()) {
            return null
        }
        if (!trimmed.contains('.')) {
            return null
        }
        if (!trimmed.matches(Regex("^[a-z0-9.-]+$"))) {
            return null
        }
        if (trimmed.startsWith(".") || trimmed.endsWith(".")) {
            return null
        }
        return trimmed
    }

    fun load(context: Context): SavedWebsiteBlock? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val websites = prefs.getStringSet(KEY_WEBSITES, emptySet())
            ?.mapNotNull(::normalizeHostname)
            ?.distinct()
            ?.sorted()
            .orEmpty()
        if (websites.isEmpty()) {
            return null
        }

        val endsAtValue = prefs.getLong(KEY_ENDS_AT, -1L)
        val endsAt = if (endsAtValue > 0) endsAtValue else null
        if (endsAt != null && endsAt <= System.currentTimeMillis()) {
            clear(context)
            return null
        }

        return SavedWebsiteBlock(websites = websites, endsAtEpochMs = endsAt)
    }

    fun save(
        context: Context,
        websites: Collection<String>,
        endsAtEpochMs: Long?,
    ) {
        val normalized = websites.mapNotNull(::normalizeHostname).distinct().sorted()
        if (normalized.isEmpty()) {
            clear(context)
            return
        }

        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_WEBSITES, normalized.toSet())
            .putLong(KEY_ENDS_AT, endsAtEpochMs ?: -1L)
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_WEBSITES)
            .remove(KEY_ENDS_AT)
            .apply()
    }

    fun isBlockedHostname(blockedWebsites: Set<String>, queryName: String): Boolean {
        val normalizedQuery = normalizeHostname(queryName) ?: return false
        return blockedWebsites.any { blocked ->
            normalizedQuery == blocked || normalizedQuery.endsWith(".$blocked")
        }
    }
}
