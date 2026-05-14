"""
Tool Simulators

Deterministic simulators backing the paper-faithful tools:

- :class:`EmailSimulator` – simulates supplier replies on a one-day lag.
  Paper analogue: "As a new day passes, every wholesaler e-mail that actually
  exists in the real world creates an AI-generated reply" (arXiv 2502.15840).
- :class:`WebSimulator` – returns canned, seed-deterministic search snippets
  for the ``search_web`` / paper ``research_products`` tool.
- :class:`Notepad` – append-only free-text scratchpad backing
  ``notepad_read`` / ``notepad_write``.

The simulators are deliberately offline: they reference no external services,
read no environment variables, and never make network calls. Determinism is
seeded so simulation traces are reproducible across runs.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from elizaos_vending_bench.types import (
    EmailMessage,
    Product,
    Supplier,
    WebSearchResult,
)

if TYPE_CHECKING:
    from elizaos_vending_bench.types import AgentState


_QUANTITY_RE = re.compile(r"(\d+)\s*(?:units?|cases?|x|of)\s*([a-z_][a-z0-9_]*)", re.IGNORECASE)
_BARE_QUANTITY_RE = re.compile(r"([a-z_][a-z0-9_]+)\s*[:=x]\s*(\d+)", re.IGNORECASE)


@dataclass
class ParsedOrderRequest:
    """Result of parsing a free-text supplier email for an order request."""

    items: dict[str, int]
    address_present: bool
    confirmed: bool


class EmailSimulator:
    """Simulates inbound and outbound supplier email.

    The simulator owns the message bus: outgoing emails (agent -> supplier) are
    stored, and when ``advance_to_day`` is called, the simulator generates
    realistic supplier replies for any messages whose ``delivery_day`` has
    arrived. Replies contain price quotes and confirmation/availability
    information that the agent must parse — there is no ``VIEW_SUPPLIERS``-style
    shortcut in this channel.
    """

    def __init__(
        self,
        suppliers: list[Supplier],
        products: dict[str, Product],
    ) -> None:
        self._suppliers_by_id = {s.supplier_id: s for s in suppliers}
        self._suppliers_by_email = {s.email.lower(): s for s in suppliers if s.email}
        self._products = products

    # ------------------------------------------------------------------ public
    def send_email(
        self,
        state: AgentState,
        to: str,
        subject: str,
        body: str,
    ) -> tuple[EmailMessage, str]:
        """Queue an outgoing email and return (message, human-readable result).

        Replies are generated lazily by :meth:`process_day`.
        """
        recipient = (to or "").strip()
        if not recipient:
            return self._reject(state, to, subject, body, "Error: missing recipient address")

        supplier = self._resolve_supplier(recipient)
        message = EmailMessage(
            message_id=f"msg_{uuid.uuid4().hex[:10]}",
            direction="out",
            sender="agent@vending-bench.local",
            recipient=recipient,
            subject=subject,
            body=body,
            sent_day=state.current_day,
            sent_date=state.current_date,
            delivery_day=state.current_day,  # supplier "receives" same day
            read=False,
        )
        state.outbox.append(message)

        if supplier is None:
            # Unknown recipient — paper failure mode: agent emailed a hallucinated supplier.
            bounce = EmailMessage(
                message_id=f"msg_{uuid.uuid4().hex[:10]}",
                direction="in",
                sender="mailer-daemon@vending-bench.local",
                recipient="agent@vending-bench.local",
                subject=f"Delivery failure: {subject}",
                body=(
                    f"The address '{recipient}' is not a registered wholesale supplier "
                    f"on this network. Your email could not be delivered.\n\n"
                    f"Known suppliers can be discovered via the search_web tool."
                ),
                sent_day=state.current_day,
                sent_date=state.current_date,
                delivery_day=state.current_day,
                in_reply_to=message.message_id,
                metadata={"bounce": "true"},
            )
            state.inbox.append(bounce)
            return message, (
                f"Email queued to {recipient!r}. Note: that address is not a known "
                f"supplier — a bounce notification was added to your inbox."
            )

        # Schedule supplier reply (1 sim-day later by default).
        reply_day = state.current_day + max(1, supplier.response_lag_days)
        reply = self._build_supplier_reply(
            state=state,
            supplier=supplier,
            inbound=message,
            reply_day=reply_day,
        )
        state.inbox.append(reply)
        return message, (
            f"Email sent to {supplier.name} <{supplier.email}>. "
            f"Expect a reply by day {reply_day}."
        )

    def read_email(self, state: AgentState, only_unread: bool = False) -> str:
        """Render the agent's inbox as plain text (newest first).

        Marks all returned messages as read.
        """
        messages = [
            m
            for m in state.inbox
            if (m.delivery_day is None or m.delivery_day <= state.current_day)
            and (not only_unread or not m.read)
        ]
        if not messages:
            return "Inbox is empty." if not only_unread else "No unread messages."

        # Newest first
        messages = sorted(messages, key=lambda m: (m.sent_day, m.message_id), reverse=True)
        rendered = ["=== Inbox ==="]
        for m in messages:
            unread_marker = "" if m.read else " [UNREAD]"
            rendered.append(
                f"\n--- {m.message_id}{unread_marker} (day {m.sent_day}) ---\n"
                f"From: {m.sender}\n"
                f"To: {m.recipient}\n"
                f"Subject: {m.subject}\n\n"
                f"{m.body}\n"
            )
            m.read = True
        return "\n".join(rendered)

    def process_day(self, state: AgentState) -> int:
        """Mark inbox messages whose delivery day arrived as visible.

        Returns the count of newly-visible messages. The actual visibility check
        in :meth:`read_email` filters by ``delivery_day``; this method is a
        no-op hook reserved for future per-day server-side processing (e.g.
        supplier promotions on certain days).
        """
        return sum(
            1
            for m in state.inbox
            if m.delivery_day == state.current_day and m.direction == "in"
        )

    # ----------------------------------------------------------------- internals
    def _reject(
        self,
        state: AgentState,
        to: str,
        subject: str,
        body: str,
        reason: str,
    ) -> tuple[EmailMessage, str]:
        msg = EmailMessage(
            message_id=f"msg_{uuid.uuid4().hex[:10]}",
            direction="out",
            sender="agent@vending-bench.local",
            recipient=to or "",
            subject=subject,
            body=body,
            sent_day=state.current_day,
            sent_date=state.current_date,
            delivery_day=state.current_day,
            metadata={"rejected": "true"},
        )
        state.outbox.append(msg)
        return msg, reason

    def _resolve_supplier(self, address: str) -> Supplier | None:
        addr = address.strip().lower()
        if addr in self._suppliers_by_email:
            return self._suppliers_by_email[addr]
        # Allow "supplier_id" as a shortcut.
        return self._suppliers_by_id.get(address.strip())

    def _build_supplier_reply(
        self,
        state: AgentState,
        supplier: Supplier,
        inbound: EmailMessage,
        reply_day: int,
    ) -> EmailMessage:
        """Generate a deterministic supplier reply.

        The reply quotes prices and lead times for any products the agent asked
        about, plus a generic catalog blurb when the request is ambiguous.
        """
        parsed = self._parse_request(inbound.body, supplier)
        lines: list[str] = [f"Thank you for contacting {supplier.name}."]

        if parsed.items:
            quoted_lines: list[str] = []
            unavailable: list[str] = []
            for product_id, qty in parsed.items.items():
                if product_id not in supplier.products:
                    unavailable.append(product_id)
                    continue
                product = self._products.get(product_id)
                if product is None:
                    unavailable.append(product_id)
                    continue
                unit_cost = product.cost_price
                line_total = unit_cost * qty
                if qty >= supplier.bulk_discount_threshold:
                    discount = Decimal(str(supplier.bulk_discount_percent / 100))
                    discounted = line_total * (Decimal("1") - discount)
                    quoted_lines.append(
                        f"  - {qty}x {product.name} (id: {product_id}): "
                        f"${unit_cost:.2f}/unit -> ${line_total:.2f} "
                        f"with {supplier.bulk_discount_percent:.0f}% bulk discount = "
                        f"${discounted:.2f}"
                    )
                else:
                    quoted_lines.append(
                        f"  - {qty}x {product.name} (id: {product_id}): "
                        f"${unit_cost:.2f}/unit -> ${line_total:.2f}"
                    )

            if quoted_lines:
                lines.append("\nWe can fulfil the following from your request:")
                lines.extend(quoted_lines)

            if unavailable:
                lines.append(
                    "\nThe following items are NOT carried by us: "
                    + ", ".join(unavailable)
                    + "."
                )

            lines.append(
                f"\nMinimum order: {supplier.minimum_order} items. "
                f"Lead time after confirmation: {supplier.lead_time_days} business days."
            )
            lines.append(
                "To confirm, place the order via PLACE_ORDER with the listed product IDs, "
                "or reply with 'CONFIRM' and we'll process it."
            )
        else:
            # Generic catalog reply.
            catalog_lines = []
            for pid in supplier.products:
                product = self._products.get(pid)
                if product is None:
                    continue
                catalog_lines.append(
                    f"  - {product.name} (id: {pid}): wholesale ${product.cost_price:.2f}/unit, "
                    f"MSRP ${product.suggested_retail:.2f}"
                )
            lines.append(
                f"\nOur current catalog ({len(catalog_lines)} items):"
            )
            lines.extend(catalog_lines)
            lines.append(
                f"\nMinimum order: {supplier.minimum_order} items. "
                f"Bulk discount: {supplier.bulk_discount_percent:.0f}% on "
                f"{supplier.bulk_discount_threshold}+ items. "
                f"Lead time: {supplier.lead_time_days} business days."
            )

        lines.append("\nBest regards,\nWholesale Account Team")
        body = "\n".join(lines)

        return EmailMessage(
            message_id=f"msg_{uuid.uuid4().hex[:10]}",
            direction="in",
            sender=supplier.email or f"{supplier.supplier_id}@vending-bench.local",
            recipient="agent@vending-bench.local",
            subject=f"Re: {inbound.subject}" if not inbound.subject.lower().startswith("re:") else inbound.subject,
            body=body,
            sent_day=reply_day,
            sent_date=state.current_date,  # nominal — actual visibility gated by delivery_day
            delivery_day=reply_day,
            in_reply_to=inbound.message_id,
        )

    def _parse_request(self, body: str, supplier: Supplier) -> ParsedOrderRequest:
        """Best-effort parse of a free-text email for an order request.

        We look for product IDs from the supplier's catalog and quantities,
        with a few simple patterns (``50 units of water``, ``water: 50``,
        ``water x50``). If none match we fall back to mentioning every supplier
        product whose ID or name appears in the body.
        """
        items: dict[str, int] = {}
        lower = body.lower()
        for match in _QUANTITY_RE.finditer(lower):
            qty = int(match.group(1))
            token = match.group(2)
            pid = self._match_product_id(token, supplier)
            if pid:
                items[pid] = items.get(pid, 0) + qty
        for match in _BARE_QUANTITY_RE.finditer(lower):
            token = match.group(1)
            qty = int(match.group(2))
            pid = self._match_product_id(token, supplier)
            if pid:
                items[pid] = items.get(pid, 0) + qty
        if not items:
            # Soft fallback: scan for any product id mentions, no quantities.
            for pid in supplier.products:
                if pid in lower:
                    items.setdefault(pid, 0)
        return ParsedOrderRequest(
            items={k: v for k, v in items.items() if v > 0},
            address_present="ship to" in lower or "deliver to" in lower,
            confirmed="confirm" in lower or "yes, please" in lower,
        )

    def _match_product_id(self, token: str, supplier: Supplier) -> str | None:
        token = token.lower().strip()
        for pid in supplier.products:
            if pid == token:
                return pid
            product = self._products.get(pid)
            if product is None:
                continue
            name = product.name.lower()
            if token == name or token == name.replace(" ", "_"):
                return pid
            # Last word of product name (e.g. "water" from "Bottled Water").
            if token == name.split()[-1]:
                return pid
        return None


# =====================================================================
class WebSimulator:
    """Deterministic, offline simulation of a web-search engine.

    The simulator owns a small canned-snippet store keyed by topic. Each query
    is normalised, then matched against topic keywords; results are stable for
    a given (seed, query) pair so traces stay reproducible. The simulator
    NEVER hits the network.
    """

    _TOPICS: dict[str, list[WebSearchResult]] = {
        "supplier": [
            WebSearchResult(
                title="Beverage Distributors Inc. - Wholesale Beverages",
                url="https://example-suppliers.test/beverage-dist",
                snippet=(
                    "Beverage Distributors Inc supplies cola, water, juice and energy "
                    "drinks to retail and vending operators. Contact: "
                    "orders@beverage-dist.example. Minimum order 12 units, 1-day lead time."
                ),
            ),
            WebSearchResult(
                title="SnackCo Wholesale - Chips, Cookies, Candy",
                url="https://example-suppliers.test/snack-co",
                snippet=(
                    "SnackCo Wholesale stocks potato chips, cookies, cheese crackers, "
                    "and chocolate bars. Email orders@snack-co.example. 2-day lead time, "
                    "10% bulk discount on 50+ unit orders."
                ),
            ),
            WebSearchResult(
                title="Healthy Choice Supplies - Bars, Trail Mix, Nuts",
                url="https://example-suppliers.test/healthy-choice",
                snippet=(
                    "Healthy Choice Supplies for protein bars, trail mix, dried fruit, "
                    "and roasted almonds. orders@healthy-choice.example. 3-day lead time."
                ),
            ),
        ],
        "weather": [
            WebSearchResult(
                title="Office building seasonal foot traffic patterns",
                url="https://example-research.test/foot-traffic",
                snippet=(
                    "Office vending sales typically peak in summer (cold beverages) "
                    "and dip during winter holidays. Weekend traffic is ~30% lower "
                    "than weekdays in commercial buildings."
                ),
            ),
        ],
        "pricing": [
            WebSearchResult(
                title="Vending machine retail markup norms",
                url="https://example-research.test/markup",
                snippet=(
                    "Typical vending markups are 2.5x to 3.5x wholesale cost. "
                    "Bottled water $1.25-$1.75 retail. Candy bars $1.50-$2.00. "
                    "Energy drinks $2.50-$3.50."
                ),
            ),
        ],
        "demand": [
            WebSearchResult(
                title="Drink consumption and weather",
                url="https://example-research.test/drinks-weather",
                snippet=(
                    "Bottled water sales rise ~80% on hot/sunny days. "
                    "Energy drink demand is largely weather-independent. "
                    "Hot beverages spike in cold weather."
                ),
            ),
        ],
    }

    def __init__(self, seed: int | None = None) -> None:
        self._seed = seed or 0

    def search(self, query: str, max_results: int = 5) -> list[WebSearchResult]:
        topics = self._classify(query)
        results: list[WebSearchResult] = []
        for topic in topics:
            results.extend(self._TOPICS.get(topic, []))
        if not results:
            # Fallback: deterministic "no good match" generic result so the
            # agent gets some signal it can reason about.
            digest = hashlib.sha1(f"{self._seed}:{query}".encode()).hexdigest()[:8]
            results = [
                WebSearchResult(
                    title=f"Generic search result for {query!r}",
                    url=f"https://example-research.test/q/{digest}",
                    snippet=(
                        "No high-confidence results matched your query. "
                        "Consider rephrasing with terms like 'wholesale supplier', "
                        "'vending pricing', or specific product names."
                    ),
                )
            ]
        return results[:max_results]

    def render(self, query: str, results: list[WebSearchResult]) -> str:
        if not results:
            return f"No results for {query!r}."
        lines = [f"=== Web search: {query!r} ({len(results)} results) ==="]
        for idx, r in enumerate(results, start=1):
            lines.append(f"\n[{idx}] {r.title}\n    {r.url}\n    {r.snippet}")
        return "\n".join(lines)

    @staticmethod
    def _classify(query: str) -> list[str]:
        q = query.lower()
        topics: list[str] = []
        if any(t in q for t in ("supplier", "wholesale", "distributor", "vendor")):
            topics.append("supplier")
        if any(t in q for t in ("weather", "season", "rain", "snow", "hot", "cold")):
            topics.append("weather")
        if any(t in q for t in ("price", "markup", "msrp", "retail")):
            topics.append("pricing")
        if any(t in q for t in ("demand", "elasticity", "sales", "popular")):
            topics.append("demand")
        return topics


# =====================================================================
class Notepad:
    """Append-only free-text scratchpad backing ``notepad_read`` / ``notepad_write``.

    Distinct from the structured key/value ``notes`` field on :class:`AgentState`.
    Lines are stored verbatim in ``state.notepad``.
    """

    @staticmethod
    def write(state: AgentState, text: str) -> str:
        text = (text or "").rstrip()
        if not text:
            return "Error: notepad write requires non-empty text"
        prefix = f"[day {state.current_day}]"
        state.notepad.append(f"{prefix} {text}")
        return f"Notepad updated ({len(state.notepad)} entries total)."

    @staticmethod
    def read(state: AgentState) -> str:
        if not state.notepad:
            return "Notepad is empty."
        lines = ["=== Notepad ==="]
        lines.extend(state.notepad)
        return "\n".join(lines)
