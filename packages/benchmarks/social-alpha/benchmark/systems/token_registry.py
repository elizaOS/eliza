"""
Token Registry — Learns CA/ticker/name associations from message history.

The real flow in trenches chat:
  1. Someone drops a CA: "FQ1tyso61AH...p8"
  2. Someone says "$VVAIFU"
  3. Everyone talks about "vvaifu" or "dasha" for the next hour

This registry pre-scans all messages to build a mapping of:
  CA → ticker → name variants

Then it can resolve "hows fartcoin doing?" to the right token
even without the CA or $TICKER in that specific message.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field


# Solana base58 address pattern (32-44 chars, no 0/O/I/l)
_CA_PATTERN = re.compile(r'\b([1-9A-HJ-NP-Za-km-z]{32,44})\b')

# EVM address pattern
_EVM_PATTERN = re.compile(r'\b(0x[a-fA-F0-9]{40})\b')

# $TICKER pattern
_DOLLAR_TICKER = re.compile(r'\$([A-Za-z][A-Za-z0-9]{1,10})\b')

# URL with embedded CA
_URL_CA = re.compile(
    r'(?:dexscreener\.com|solscan\.io|birdeye\.so|pump\.fun)[^\s]*?'
    r'([1-9A-HJ-NP-Za-km-z]{32,44})'
)

# Words that are definitely NOT token names
_STOP_WORDS = {
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'was', 'one', 'out', 'get', 'has', 'how', 'its', 'let', 'may', 'new',
    'now', 'see', 'way', 'who', 'did', 'say', 'she', 'too', 'use', 'just',
    'like', 'this', 'that', 'what', 'when', 'with', 'from', 'they', 'been',
    'some', 'than', 'them', 'then', 'very', 'much', 'think', 'about', 'will',
    'have', 'into', 'here', 'also', 'yeah', 'lol', 'lmao', 'bruh', 'bro',
    'man', 'guys', 'right', 'going', 'would', 'could', 'should', 'still',
    'look', 'good', 'nice', 'well', 'shit', 'fuck', 'damn',
}


@dataclass
class TokenEntry:
    """A known token with all its identifiers."""
    primary_ca: str  # canonical contract address
    tickers: set[str] = field(default_factory=set)  # all known ticker symbols
    names: set[str] = field(default_factory=set)  # all name variants (lowercased)
    mention_count: int = 0

    @property
    def best_ticker(self) -> str:
        """Most common ticker, or first one found."""
        if not self.tickers:
            return ""
        # Prefer uppercase, shortest
        sorted_tickers = sorted(self.tickers, key=lambda t: (len(t), t))
        return sorted_tickers[0].upper()


class TokenRegistry:
    """
    Learns and maintains CA → ticker → name mappings from message history.

    Usage:
        registry = TokenRegistry()
        registry.scan_messages(all_message_texts)  # pre-scan to build knowledge
        registry.resolve("hows fartcoin doing?")   # returns TokenEntry or None
    """

    def __init__(self) -> None:
        self._by_ca: dict[str, TokenEntry] = {}
        self._by_ticker: dict[str, TokenEntry] = {}  # uppercase ticker -> entry
        self._by_name: dict[str, TokenEntry] = {}  # lowercase name -> entry
        self._ticker_counts: dict[str, int] = {}  # ticker -> total mention count

    @property
    def num_tokens(self) -> int:
        return len(self._by_ca)

    @property
    def num_tickers(self) -> int:
        return len(self._by_ticker)

    @property
    def num_names(self) -> int:
        return len(self._by_name)

    def scan_messages(self, messages: list[str]) -> None:
        """Pre-scan all messages to build token knowledge base."""
        for msg in messages:
            self._learn_from_message(msg)

    def _learn_from_message(self, text: str) -> None:
        """Extract and link CAs, tickers, and names from a single message."""
        # Find CAs
        cas = _CA_PATTERN.findall(text)
        url_cas = _URL_CA.findall(text)
        cas.extend(url_cas)
        evm_cas = _EVM_PATTERN.findall(text)
        cas.extend(evm_cas)

        # Find $TICKER mentions
        tickers = [t.upper() for t in _DOLLAR_TICKER.findall(text)]
        for t in tickers:
            self._ticker_counts[t] = self._ticker_counts.get(t, 0) + 1

        # If we have both CA and ticker in the same message, link them
        if cas and tickers:
            ca = cas[0]
            entry = self._get_or_create(ca)
            for t in tickers:
                entry.tickers.add(t)
                self._by_ticker[t] = entry
            entry.mention_count += 1

        # If we have CA but no ticker, just register the CA
        elif cas:
            for ca in cas:
                entry = self._get_or_create(ca)
                entry.mention_count += 1

        # If we have ticker but no CA, register the ticker
        elif tickers:
            for t in tickers:
                if t in self._by_ticker:
                    self._by_ticker[t].mention_count += 1

        # Extract potential name references (words near known tickers)
        # This is a second pass after all CAs and tickers are registered
        words = text.lower().split()
        for word in words:
            clean = re.sub(r'[^a-z0-9]', '', word)
            if len(clean) < 2 or clean in _STOP_WORDS:
                continue
            # Check if this word matches a known ticker (case-insensitive)
            upper = clean.upper()
            if upper in self._by_ticker:
                entry = self._by_ticker[upper]
                entry.names.add(clean)
                self._by_name[clean] = entry

    def _get_or_create(self, ca: str) -> TokenEntry:
        """Get or create a token entry for a CA."""
        if ca in self._by_ca:
            return self._by_ca[ca]
        entry = TokenEntry(primary_ca=ca)
        self._by_ca[ca] = entry
        return entry

    def link_names_from_ground_truth(self, tokens: list[dict]) -> None:
        """Optionally link name variants from the dataset's token manifest."""
        for token in tokens:
            addr = token.get("address", "")
            symbol = token.get("symbol", "")
            name = token.get("name", "")
            if not addr:
                continue
            entry = self._get_or_create(addr)
            if symbol:
                entry.tickers.add(symbol.upper())
                self._by_ticker[symbol.upper()] = entry
            if name:
                entry.names.add(name.lower())
                self._by_name[name.lower()] = entry

    def resolve(self, text: str) -> TokenEntry | None:
        """Try to resolve a message to a known token.

        Priority:
          1. CA in the text (exact match)
          2. $TICKER in the text
          3. Known ticker word in the text
          4. Known name word in the text (fuzzy)
        """
        # 1. CA
        cas = _CA_PATTERN.findall(text)
        for ca in cas:
            if ca in self._by_ca:
                return self._by_ca[ca]

        # 2. $TICKER
        tickers = _DOLLAR_TICKER.findall(text)
        for t in tickers:
            upper = t.upper()
            if upper in self._by_ticker:
                return self._by_ticker[upper]

        # 3. Known ticker as a word
        words = text.upper().split()
        for word in words:
            clean = re.sub(r'[^A-Z0-9]', '', word)
            if clean in self._by_ticker and self._ticker_counts.get(clean, 0) >= 2:
                return self._by_ticker[clean]

        # 4. Known name (lowercased)
        lower_words = text.lower().split()
        for word in lower_words:
            clean = re.sub(r'[^a-z0-9]', '', word)
            if clean in self._by_name and len(clean) >= 3:
                return self._by_name[clean]

        return None

    def get_context_for_llm(self, top_n: int = 40) -> str:
        """Generate a context string for the LLM prompt showing known tokens."""
        # Sort by mention count
        entries = sorted(self._by_ca.values(), key=lambda e: -e.mention_count)[:top_n]
        if not entries:
            return ""

        lines = []
        for e in entries:
            ticker = e.best_ticker
            names = ", ".join(sorted(e.names)[:3]) if e.names else ""
            ca_short = e.primary_ca[:12] + "..."
            parts = [f"{ticker}" if ticker else ca_short]
            if names:
                parts.append(f"(also: {names})")
            parts.append(f"[{e.mention_count}x]")
            lines.append(" ".join(parts))

        return "Known active tokens: " + " | ".join(lines)

    def summary(self) -> str:
        return (f"TokenRegistry: {self.num_tokens} tokens, {self.num_tickers} tickers, "
                f"{self.num_names} name variants")
