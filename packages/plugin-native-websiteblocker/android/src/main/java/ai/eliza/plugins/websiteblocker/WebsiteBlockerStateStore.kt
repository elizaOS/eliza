package ai.eliza.plugins.websiteblocker

import android.content.Context

data class SavedWebsiteBlock(
    val requestedWebsites: List<String>,
    val blockedWebsites: List<String>,
    val allowedWebsites: List<String>,
    val matchMode: String,
    val endsAtEpochMs: Long?,
)

object WebsiteBlockerStateStore {
    private const val PREFS_NAME = "eliza_website_blocker"
    private const val KEY_REQUESTED_WEBSITES = "requested_websites"
    private const val KEY_BLOCKED_WEBSITES = "blocked_websites"
    private const val KEY_ALLOWED_WEBSITES = "allowed_websites"
    private const val KEY_MATCH_MODE = "match_mode"
    private const val KEY_WEBSITES = "websites"
    private const val KEY_ENDS_AT = "ends_at_epoch_ms"
    private const val MATCH_MODE_EXACT = "exact"
    private const val MATCH_MODE_SUBDOMAIN = "subdomain"

    private val X_TWITTER_REQUESTED_HOSTS = setOf("x.com", "twitter.com")
    private val X_TWITTER_BLOCKED_HOSTS = setOf(
        "x.com",
        "www.x.com",
        "mobile.x.com",
        "twitter.com",
        "www.twitter.com",
        "mobile.twitter.com",
        "t.co",
        "abs.twimg.com",
        "pbs.twimg.com",
        "video.twimg.com",
        "ton.twimg.com",
        "platform.twitter.com",
        "tweetdeck.twitter.com",
    )
    private val X_TWITTER_ALLOWED_HOSTS = setOf("api.x.com", "api.twitter.com")
    private val GOOGLE_NEWS_REQUESTED_HOSTS = setOf("news.google.com")
    private val GOOGLE_NEWS_BLOCKED_HOSTS = setOf("news.google.com")
    private val GOOGLE_NEWS_ALLOWED_HOSTS = setOf(
        "accounts.google.com",
        "oauth2.googleapis.com",
        "openidconnect.googleapis.com",
        "www.googleapis.com",
    )

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

    private data class WebsiteBlockPolicy(
        val requestedWebsites: List<String>,
        val blockedWebsites: List<String>,
        val allowedWebsites: List<String>,
        val matchMode: String,
    )

    private fun shouldAddWwwVariant(hostname: String): Boolean {
        val parts = hostname.split(".")
        return parts.size == 2 && parts[0] != "www"
    }

    private fun buildPolicy(requestedWebsites: Collection<String>): WebsiteBlockPolicy {
        val normalizedRequested = requestedWebsites.mapNotNull(::normalizeHostname)
            .distinct()
            .sorted()
        val blockedWebsites = linkedSetOf<String>()
        val allowedWebsites = linkedSetOf<String>()

        for (website in normalizedRequested) {
            blockedWebsites += website

            if (shouldAddWwwVariant(website)) {
                blockedWebsites += "www.$website"
            }

            when {
                website in X_TWITTER_REQUESTED_HOSTS -> {
                    blockedWebsites += X_TWITTER_BLOCKED_HOSTS
                    allowedWebsites += X_TWITTER_ALLOWED_HOSTS
                }
                website in GOOGLE_NEWS_REQUESTED_HOSTS -> {
                    blockedWebsites += GOOGLE_NEWS_BLOCKED_HOSTS
                    allowedWebsites += GOOGLE_NEWS_ALLOWED_HOSTS
                }
            }
        }

        return WebsiteBlockPolicy(
            requestedWebsites = normalizedRequested,
            blockedWebsites = blockedWebsites.mapNotNull(::normalizeHostname).distinct().sorted(),
            allowedWebsites = allowedWebsites.mapNotNull(::normalizeHostname).distinct().sorted(),
            matchMode = MATCH_MODE_EXACT,
        )
    }

    private fun readNormalizedWebsiteSet(prefs: android.content.SharedPreferences, key: String): List<String> {
        return prefs.getStringSet(key, null)
            ?.mapNotNull(::normalizeHostname)
            ?.distinct()
            ?.sorted()
            .orEmpty()
    }

    fun load(context: Context): SavedWebsiteBlock? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val requestedWebsites = readNormalizedWebsiteSet(prefs, KEY_REQUESTED_WEBSITES)
            .ifEmpty { readNormalizedWebsiteSet(prefs, KEY_WEBSITES) }
        if (requestedWebsites.isEmpty()) {
            return null
        }

        val policy = buildPolicy(requestedWebsites)
        val blockedWebsites = readNormalizedWebsiteSet(prefs, KEY_BLOCKED_WEBSITES)
            .ifEmpty { policy.blockedWebsites }
        val allowedWebsites = readNormalizedWebsiteSet(prefs, KEY_ALLOWED_WEBSITES)
            .ifEmpty { policy.allowedWebsites }
        val matchMode = prefs.getString(KEY_MATCH_MODE, MATCH_MODE_EXACT)
            ?.lowercase()
            ?.takeIf { it == MATCH_MODE_SUBDOMAIN }
            ?: MATCH_MODE_EXACT
        val endsAtValue = prefs.getLong(KEY_ENDS_AT, -1L)
        val endsAt = if (endsAtValue > 0) endsAtValue else null
        if (endsAt != null && endsAt <= System.currentTimeMillis()) {
            clear(context)
            return null
        }

        return SavedWebsiteBlock(
            requestedWebsites = requestedWebsites,
            blockedWebsites = blockedWebsites,
            allowedWebsites = allowedWebsites,
            matchMode = matchMode,
            endsAtEpochMs = endsAt,
        )
    }

    fun save(
        context: Context,
        websites: Collection<String>,
        endsAtEpochMs: Long?,
    ): SavedWebsiteBlock? {
        val policy = buildPolicy(websites)
        if (policy.requestedWebsites.isEmpty()) {
            clear(context)
            return null
        }

        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putStringSet(KEY_REQUESTED_WEBSITES, policy.requestedWebsites.toSet())
            .putStringSet(KEY_BLOCKED_WEBSITES, policy.blockedWebsites.toSet())
            .putStringSet(KEY_ALLOWED_WEBSITES, policy.allowedWebsites.toSet())
            .putString(KEY_MATCH_MODE, policy.matchMode)
            .putStringSet(KEY_WEBSITES, policy.requestedWebsites.toSet())
            .putLong(KEY_ENDS_AT, endsAtEpochMs ?: -1L)
            .apply()
        return SavedWebsiteBlock(
            requestedWebsites = policy.requestedWebsites,
            blockedWebsites = policy.blockedWebsites,
            allowedWebsites = policy.allowedWebsites,
            matchMode = policy.matchMode,
            endsAtEpochMs = endsAtEpochMs,
        )
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_REQUESTED_WEBSITES)
            .remove(KEY_BLOCKED_WEBSITES)
            .remove(KEY_ALLOWED_WEBSITES)
            .remove(KEY_MATCH_MODE)
            .remove(KEY_WEBSITES)
            .remove(KEY_ENDS_AT)
            .apply()
    }

    fun isBlockedHostname(policy: SavedWebsiteBlock, queryName: String): Boolean {
        val normalizedQuery = normalizeHostname(queryName) ?: return false
        if (policy.allowedWebsites.any { allowed -> normalizedQuery == allowed }) {
            return false
        }
        return policy.blockedWebsites.any { blocked ->
            normalizedQuery == blocked ||
                (policy.matchMode == MATCH_MODE_SUBDOMAIN && normalizedQuery.endsWith(".$blocked"))
        }
    }
}
