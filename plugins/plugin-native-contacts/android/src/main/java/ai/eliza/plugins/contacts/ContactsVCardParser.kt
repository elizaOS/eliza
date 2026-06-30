package ai.eliza.plugins.contacts

/**
 * RFC 6350 vCard parsing for contact import, extracted from [ContactsPlugin] so
 * the line-unfolding, name fallback, and value-unescaping logic can be
 * unit-tested without an Android device (see `ContactsVCardParserTest`). Pure
 * string processing — no Android framework dependencies.
 */
object ContactsVCardParser {
    data class ParsedVCard(
        val displayName: String,
        val phoneNumbers: List<String>,
        val emailAddresses: List<String>,
    )

    fun parse(input: String): List<ParsedVCard> {
        val unfolded = unfoldVCardLines(input)
        val contacts = mutableListOf<ParsedVCard>()
        var current = mutableListOf<String>()
        var insideCard = false
        for (line in unfolded) {
            val upper = line.uppercase()
            if (upper == "BEGIN:VCARD") {
                insideCard = true
                current = mutableListOf()
            } else if (upper == "END:VCARD") {
                if (insideCard) {
                    parseVCard(current)?.let { contacts.add(it) }
                }
                insideCard = false
                current = mutableListOf()
            } else if (insideCard) {
                current.add(line)
            }
        }
        if (contacts.isEmpty()) {
            parseVCard(unfolded)?.let { contacts.add(it) }
        }
        return contacts
    }

    fun unfoldVCardLines(input: String): List<String> {
        val lines = mutableListOf<String>()
        for (rawLine in input.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
            if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && lines.isNotEmpty()) {
                lines[lines.lastIndex] = lines.last() + rawLine.drop(1)
            } else {
                lines.add(rawLine.trimEnd())
            }
        }
        return lines
    }

    private fun parseVCard(lines: List<String>): ParsedVCard? {
        var fullName: String? = null
        var structuredName: String? = null
        val phoneNumbers = mutableListOf<String>()
        val emailAddresses = mutableListOf<String>()
        for (line in lines) {
            val separator = line.indexOf(':')
            if (separator <= 0) continue
            val key = line.substring(0, separator).substringBefore(';').uppercase()
            val value = decodeVCardValue(line.substring(separator + 1)).trim()
            if (value.isEmpty()) continue
            when (key) {
                "FN" -> fullName = value
                "N" -> structuredName = structuredNameToDisplayName(value)
                "TEL" -> phoneNumbers.add(value)
                "EMAIL" -> emailAddresses.add(value)
            }
        }
        val displayName = fullName ?: structuredName ?: phoneNumbers.firstOrNull() ?: emailAddresses.firstOrNull()
        if (displayName.isNullOrBlank()) return null
        return ParsedVCard(
            displayName = displayName,
            phoneNumbers = phoneNumbers.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
            emailAddresses = emailAddresses.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
        )
    }

    private fun structuredNameToDisplayName(value: String): String {
        val parts = value.split(';').map { decodeVCardValue(it).trim() }
        val family = parts.getOrNull(0).orEmpty()
        val given = parts.getOrNull(1).orEmpty()
        val additional = parts.getOrNull(2).orEmpty()
        val prefix = parts.getOrNull(3).orEmpty()
        val suffix = parts.getOrNull(4).orEmpty()
        return listOf(prefix, given, additional, family, suffix)
            .filter { it.isNotEmpty() }
            .joinToString(" ")
    }

    private fun decodeVCardValue(value: String): String {
        return value
            .replace("\\n", "\n")
            .replace("\\N", "\n")
            .replace("\\,", ",")
            .replace("\\;", ";")
            .replace("\\\\", "\\")
    }
}
