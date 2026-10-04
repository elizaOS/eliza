package ai.eliza.plugins.browsersurface

import org.junit.Assert.*
import org.junit.Test

class BrowserEmbeddingTrustTest {
    private val host = "ab".repeat(32)
    private val other = "cd".repeat(32)
    private fun accepted(bytes: ByteArray) = bytes.all { it == 0xab.toByte() }

    @Test fun acceptsEachActivityWithARecognizedHostSigner() {
        BrowserEmbeddingTrust.requireCertificates(List(4) { setOf(other, host.uppercase()) }, ::accepted)
    }

    @Test fun rejectsAbsentWrongMalformedAndIncompleteTrust() {
        val cases = listOf(
            emptyList(), List(3) { setOf(host) }, List(4) { emptySet<String>() },
            List(4) { setOf(other) }, List(4) { setOf("*", "ab") },
            listOf(emptySet(), setOf(host), setOf(host), setOf(host)),
            listOf(setOf(host), setOf(host), setOf(other), setOf(host))
        )
        for (certificates in cases) {
            val error = assertThrows(BrowserLaunchException::class.java) {
                BrowserEmbeddingTrust.requireCertificates(certificates, ::accepted)
            }
            assertEquals("BROWSER_DOCK_UNTRUSTED", error.code)
        }
    }
}
