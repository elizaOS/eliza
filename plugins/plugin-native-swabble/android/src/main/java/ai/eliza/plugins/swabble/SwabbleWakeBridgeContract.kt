package ai.eliza.plugins.swabble

import com.getcapacitor.JSObject

internal object SwabbleWakeBridgeContract {
    data class Config(
        val triggers: List<String>,
        val minPostTriggerGap: Double,
        val minCommandLength: Int
    )

    data class Segment(
        val text: String,
        val start: Double,
        val duration: Double
    ) {
        val end: Double get() = start + duration
    }

    data class WakeWordMatch(
        val wakeWord: String,
        val command: String,
        val postGap: Double
    )

    fun matchWakeWord(
        transcript: String,
        segments: List<Segment>,
        config: Config
    ): WakeWordMatch? {
        for (trigger in config.triggers) {
            val command = extractCommandExact(transcript, trigger)
            if (command != null && command.length >= config.minCommandLength) {
                return WakeWordMatch(
                    wakeWord = trigger,
                    command = command,
                    postGap = config.minPostTriggerGap
                )
            }
        }

        val words = transcript.split("\\s+".toRegex()).filter { it.isNotEmpty() }
        for ((wordIndex, _) in words.withIndex()) {
            for (trigger in config.triggers) {
                val triggerWords = trigger.split("\\s+".toRegex()).filter { it.isNotEmpty() }
                val triggerLen = triggerWords.size
                if (wordIndex + triggerLen > words.size) continue

                val candidate = words.subList(wordIndex, wordIndex + triggerLen).joinToString(" ")
                val distance = levenshteinDistance(candidate.lowercase(), trigger.lowercase())
                val maxLen = maxOf(candidate.length, trigger.length)
                if (maxLen == 0 || distance.toDouble() / maxLen > 0.3) continue

                val commandStart = wordIndex + triggerLen
                if (commandStart >= words.size) continue

                val command = words.subList(commandStart, words.size).joinToString(" ").trim()
                if (command.length < config.minCommandLength) continue

                val gap = if (commandStart < segments.size && wordIndex + triggerLen - 1 < segments.size) {
                    val triggerEnd = segments[wordIndex + triggerLen - 1].end
                    val commandBegin = segments[commandStart].start
                    commandBegin - triggerEnd
                } else {
                    config.minPostTriggerGap
                }

                return WakeWordMatch(
                    wakeWord = trigger,
                    command = cleanCommand(command),
                    postGap = gap
                )
            }
        }

        return null
    }

    fun wakeWordPayload(
        match: WakeWordMatch,
        transcript: String,
        confidence: Double
    ): Map<String, Any?> = mapOf(
        "wakeWord" to match.wakeWord,
        "command" to match.command,
        "transcript" to transcript,
        "postGap" to match.postGap,
        "confidence" to confidence
    )

    private fun extractCommandExact(text: String, trigger: String): String? {
        val raw = text.trim()
        if (raw.isEmpty()) return null

        val normalizedTrigger = trigger.trim().lowercase()
        if (normalizedTrigger.isEmpty()) return null

        val escaped = Regex.escape(normalizedTrigger)
        val regex = Regex("(?i)(?:^|\\s)($escaped)\\b[\\s\\p{Punct}]*([\\s\\S]+)$")
        val match = regex.find(raw) ?: return null
        val extracted = match.groupValues.getOrNull(2)?.trim() ?: return null
        if (extracted.isEmpty()) return null

        return cleanCommand(extracted)
    }

    private fun cleanCommand(text: String): String {
        return text.trimStart { it.isWhitespace() || it.isPunctuation() }.trim()
    }

    private fun Char.isPunctuation(): Boolean {
        return when (Character.getType(this)) {
            Character.CONNECTOR_PUNCTUATION.toInt(),
            Character.DASH_PUNCTUATION.toInt(),
            Character.START_PUNCTUATION.toInt(),
            Character.END_PUNCTUATION.toInt(),
            Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
            Character.FINAL_QUOTE_PUNCTUATION.toInt(),
            Character.OTHER_PUNCTUATION.toInt() -> true
            else -> false
        }
    }

    private fun levenshteinDistance(a: String, b: String): Int {
        val m = a.length
        val n = b.length
        if (m == 0) return n
        if (n == 0) return m

        var prev = IntArray(n + 1) { it }
        var curr = IntArray(n + 1)

        for (i in 1..m) {
            curr[0] = i
            for (j in 1..n) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                curr[j] = minOf(
                    prev[j] + 1,
                    curr[j - 1] + 1,
                    prev[j - 1] + cost
                )
            }
            val tmp = prev
            prev = curr
            curr = tmp
        }
        return prev[n]
    }
}

internal fun Map<String, Any?>.toJSObject(): JSObject {
    val obj = JSObject()
    for ((key, value) in this) {
        obj.put(key, value)
    }
    return obj
}
