"""LifeWorld money action semantics."""

from __future__ import annotations
import re
from datetime import datetime, timedelta
from typing import Any
from .world import LifeWorld
from .action_common import UnsupportedAction, _strict_positive_integer, _try_parse_iso


def _money_window_days(value: Any, *, default: int) -> int:
    return _strict_positive_integer(
        value,
        field="MONEY windowDays",
        default=default,
        maximum=3650,
    )


def _money_bounds(
    world: LifeWorld,
    kw: dict[str, Any],
    *,
    window_field: str = "windowDays",
    default_days: int,
) -> tuple[datetime, datetime, int]:
    now = _try_parse_iso(world.now_iso)
    if now is None:
        raise ValueError(f"LifeWorld has invalid now_iso: {world.now_iso!r}")
    days = _money_window_days(
        kw.get(window_field, kw.get("window_days")),
        default=default_days,
    )
    start_raw = kw.get("start_date") or kw.get("startDate")
    end_raw = kw.get("end_date") or kw.get("endDate")
    start = now - timedelta(days=days)
    end = now
    if start_raw is not None:
        if not isinstance(start_raw, str):
            raise ValueError("MONEY startDate must be an ISO date/time")
        parsed = _try_parse_iso(start_raw)
        if parsed is None:
            raise ValueError("MONEY startDate must be an ISO date/time")
        start = parsed
    if end_raw is not None:
        if not isinstance(end_raw, str):
            raise ValueError("MONEY endDate must be an ISO date/time")
        parsed = _try_parse_iso(end_raw)
        if parsed is None:
            raise ValueError("MONEY endDate must be an ISO date/time")
        end = parsed
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", end_raw):
            end += timedelta(days=1) - timedelta(microseconds=1)
    if start > end:
        raise ValueError("MONEY startDate must not be after endDate")
    return start, end, days


def _money_filtered_transactions(
    world: LifeWorld,
    kw: dict[str, Any],
    *,
    default_days: int,
) -> tuple[list[Any], int]:
    start, end, days = _money_bounds(world, kw, default_days=default_days)
    category_raw = kw.get("category")
    if category_raw is not None and not isinstance(category_raw, str):
        raise ValueError("MONEY category must be a string")
    category = (category_raw or "").strip().casefold()
    merchant_raw = kw.get("merchantContains", kw.get("merchant"))
    if merchant_raw is not None and not isinstance(merchant_raw, str):
        raise ValueError("MONEY merchantContains must be a string")
    merchant = (merchant_raw or "").strip().casefold()
    only_debits_raw = kw.get("onlyDebits", kw.get("only_debits", False))
    if not isinstance(only_debits_raw, bool):
        raise ValueError("MONEY onlyDebits must be boolean")

    filtered = []
    for transaction in world.transactions.values():
        posted = _try_parse_iso(transaction.posted_at)
        if posted is None:
            raise ValueError(
                f"LifeWorld transaction {transaction.id} has invalid posted_at"
            )
        if posted < start or posted > end:
            continue
        if category and transaction.category.casefold() != category:
            continue
        if merchant and merchant not in transaction.merchant.casefold():
            continue
        if only_debits_raw and transaction.amount_cents >= 0:
            continue
        filtered.append(transaction)
    filtered.sort(key=lambda item: (item.posted_at, item.id), reverse=True)
    return filtered, days


def _money_transaction_projection(transaction: Any) -> dict[str, Any]:
    return {
        "id": transaction.id,
        "accountId": transaction.account_id,
        "merchant": transaction.merchant,
        "category": transaction.category,
        "description": transaction.description,
        "amountCents": transaction.amount_cents,
        "currency": transaction.currency,
        "postedAt": transaction.posted_at,
        "isPending": transaction.is_pending,
    }


def _money_grouped_spending(
    transactions: list[Any],
    *,
    group_by: str,
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], int] = {}
    for transaction in transactions:
        key_value = {
            "account": transaction.account_id,
            "category": transaction.category,
            "merchant": transaction.merchant,
        }[group_by]
        key = (key_value, transaction.currency)
        grouped[key] = grouped.get(key, 0) + transaction.amount_cents
    return [
        {
            "key": key,
            "currency": currency,
            "netCents": amount,
            "spendingCents": max(0, -amount),
        }
        for (key, currency), amount in sorted(grouped.items())
    ]


def _subscription_slug(name: str) -> str:
    normalized = name.casefold().replace("+", " plus ")
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")


def _find_subscription(world: LifeWorld, kw: dict[str, Any]) -> Any:
    subscription_id = kw.get("subscriptionId") or kw.get("subscription_id")
    if subscription_id is not None:
        if not isinstance(subscription_id, str) or not subscription_id:
            raise ValueError("MONEY subscriptionId must be a non-empty string")
        subscription = world.subscriptions.get(subscription_id)
        if subscription is None:
            raise KeyError(f"MONEY subscription not found: {subscription_id}")
        return subscription
    service_name = kw.get("serviceName")
    service_slug = kw.get("serviceSlug")
    if service_name is not None and (
        not isinstance(service_name, str) or not service_name.strip()
    ):
        raise ValueError("MONEY serviceName must be a non-empty string")
    if service_slug is not None and (
        not isinstance(service_slug, str) or not service_slug.strip()
    ):
        raise ValueError("MONEY serviceSlug must be a non-empty string")
    if service_name is None and service_slug is None:
        raise KeyError(
            "MONEY subscription operation requires serviceName or serviceSlug"
        )
    matches = [
        subscription
        for subscription in world.subscriptions.values()
        if (
            isinstance(service_name, str)
            and subscription.name.casefold() == service_name.strip().casefold()
        )
        or (
            isinstance(service_slug, str)
            and _subscription_slug(subscription.name) == service_slug.strip().casefold()
        )
    ]
    if not matches:
        raise KeyError(
            f"MONEY subscription not found for serviceName={service_name!r}, "
            f"serviceSlug={service_slug!r}"
        )
    if len(matches) > 1:
        raise ValueError("MONEY subscription reference is ambiguous")
    return matches[0]


def _subscription_projection(
    subscription: Any,
    *,
    transactions: list[Any],
) -> dict[str, Any]:
    observed = [
        transaction
        for transaction in transactions
        if transaction.merchant.casefold() == subscription.name.casefold()
    ]
    observed.sort(key=lambda item: (item.posted_at, item.id), reverse=True)
    categories = sorted({item.category for item in observed})
    return {
        "id": subscription.id,
        "name": subscription.name,
        "slug": _subscription_slug(subscription.name),
        "monthlyCents": subscription.monthly_cents,
        "billingDay": subscription.billing_day,
        "nextChargeAt": subscription.next_charge_at,
        "status": subscription.status,
        "observedChargeCount": len(observed),
        "lastObservedChargeAt": observed[0].posted_at if observed else None,
        "categories": categories,
    }


def _u_money_readonly(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Return typed account, transaction, spending, and subscription projections."""
    raw_subaction = kw.get("subaction", "dashboard")
    aliases = {"status": "subscription_status", "audit": "subscription_audit"}
    subaction = aliases.get(raw_subaction, raw_subaction)
    if subaction not in {
        "dashboard",
        "list_sources",
        "list_transactions",
        "recurring_charges",
        "spending_summary",
        "subscription_status",
    }:
        raise UnsupportedAction(
            f"unsupported action in execute path: MONEY/{subaction}"
        )

    if subaction == "list_sources":
        accounts = [
            {
                "id": account.id,
                "institution": account.institution,
                "accountType": account.account_type,
                "balanceCents": account.balance_cents,
                "currency": account.currency,
                "last4": account.last4,
            }
            for account in sorted(world.accounts.values(), key=lambda item: item.id)
        ]
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "accounts": accounts,
            "count": len(accounts),
        }

    if subaction == "subscription_status":
        subscription = _find_subscription(world, kw)
        transactions, days = _money_filtered_transactions(
            world,
            {"windowDays": kw.get("windowDays", 3650)},
            default_days=3650,
        )
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "subscription": _subscription_projection(
                subscription,
                transactions=transactions,
            ),
        }

    transactions, days = _money_filtered_transactions(
        world,
        kw,
        default_days=30 if subaction != "recurring_charges" else 180,
    )
    if subaction == "list_transactions":
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "transactions": [
                _money_transaction_projection(transaction)
                for transaction in transactions
            ],
            "count": len(transactions),
        }

    if subaction == "recurring_charges":
        subscriptions = [
            _subscription_projection(subscription, transactions=transactions)
            for subscription in sorted(
                world.subscriptions.values(),
                key=lambda item: item.id,
            )
            if subscription.status != "cancelled"
        ]
        return {
            "ok": True,
            "effect": "none",
            "subaction": subaction,
            "windowDays": days,
            "subscriptions": subscriptions,
            "count": len(subscriptions),
        }

    group_by_raw = kw.get("groupBy", "category")
    if group_by_raw not in {"account", "category", "merchant"}:
        raise ValueError("MONEY groupBy must be one of account, category, or merchant")
    groups = _money_grouped_spending(transactions, group_by=group_by_raw)
    totals_by_currency: dict[str, dict[str, int]] = {}
    for transaction in transactions:
        totals = totals_by_currency.setdefault(
            transaction.currency,
            {"incomeCents": 0, "spendingCents": 0, "netCents": 0},
        )
        totals["netCents"] += transaction.amount_cents
        if transaction.amount_cents < 0:
            totals["spendingCents"] += -transaction.amount_cents
        else:
            totals["incomeCents"] += transaction.amount_cents

    result: dict[str, Any] = {
        "ok": True,
        "effect": "none",
        "subaction": subaction,
        "windowDays": days,
        "transactionCount": len(transactions),
        "totalsByCurrency": totals_by_currency,
        "groupBy": group_by_raw,
        "groups": groups,
    }
    if subaction == "dashboard":
        balances: dict[str, int] = {}
        for account in world.accounts.values():
            balances[account.currency] = (
                balances.get(account.currency, 0) + account.balance_cents
            )
        result["accountCount"] = len(world.accounts)
        result["balancesByCurrency"] = balances
        result["pendingTransactionCount"] = sum(
            transaction.is_pending for transaction in transactions
        )
    return result


def _u_money_subscription_audit(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Compare subscription records with observed charges in a bounded window."""
    days = _money_window_days(kw.get("queryWindowDays"), default=365)
    transactions, _ = _money_filtered_transactions(
        world,
        {"windowDays": days},
        default_days=days,
    )
    category_raw = kw.get("category")
    if category_raw is not None and (
        not isinstance(category_raw, str) or not category_raw.strip()
    ):
        raise ValueError("MONEY subscription audit category must be a non-empty string")
    category = (
        category_raw.strip().casefold() if isinstance(category_raw, str) else None
    )
    projections = [
        _subscription_projection(subscription, transactions=transactions)
        for subscription in sorted(
            world.subscriptions.values(), key=lambda item: item.id
        )
    ]
    if category is not None:
        projections = [
            item
            for item in projections
            if category in {value.casefold() for value in item["categories"]}
        ]
    active = [item for item in projections if item["status"] == "active"]
    return {
        "ok": True,
        "effect": "none",
        "subaction": "subscription_audit",
        "windowDays": days,
        "category": category,
        "subscriptions": projections,
        "activeCount": len(active),
        "monthlyActiveCents": sum(item["monthlyCents"] for item in active),
    }


def _u_money_subscription_cancel(
    world: LifeWorld, kw: dict[str, Any], _name: str
) -> dict[str, Any]:
    """Cancel a subscription. Resolves by serviceSlug first, then serviceName."""
    confirmed = kw.get("confirmed", False)
    if not isinstance(confirmed, bool):
        raise ValueError("MONEY_SUBSCRIPTION_CANCEL confirmed must be boolean")
    if not confirmed:
        return {
            "subaction": "cancel",
            "ok": False,
            "status": "confirmation_required",
            "noEffect": True,
            "reason": "unconfirmed",
        }
    subscription = _find_subscription(world, kw)
    if subscription.status == "cancelled":
        return {
            "id": subscription.id,
            "status": subscription.status,
            "replayed": True,
        }
    cancelled = world.cancel_subscription(subscription.id)
    return {"id": cancelled.id, "status": cancelled.status, "replayed": False}
