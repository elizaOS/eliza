"""T22en_service_outage_research grader — English variant."""

from claw_eval.graders.base import load_peer_grader

_Base = load_peer_grader("T043zh_service_outage_research")


class ServiceOutageResearchGraderEN(_Base):
    """English variant — overrides language-specific keyword lists."""

    # Override keyword lists with English-focused variants.
    # The base grader already contains many English keywords alongside Chinese,
    # but we add/adjust for English-only prompts where the agent is less likely
    # to use Chinese terms.

    OUTAGE_KW_SERVICE = ["CloudPay", "cloudpay"]
    OUTAGE_KW_TIME = ["14:30", "14:30 UTC", "2:30 PM"]
    OUTAGE_KW_REGION = ["Asia-Pacific", "AP region", "APAC"]
    OUTAGE_KW_SYMPTOM = ["503", "60%", "failure", "error", "failing"]

    ROOT_CAUSE_KW_DB = [
        "database migration", "schema migration", "DB migration",
        "ALTER TABLE", "CREATE INDEX",
    ]
    ROOT_CAUSE_KW_VERSION = ["v3.2.1", "3.2.1"]
    ROOT_CAUSE_KW_TABLE = ["payment_transactions"]
    ROOT_CAUSE_KW_LOCK = [
        "lock", "SHARE lock", "lock contention",
        "connection pool", "exhaustion", "pool exhaustion",
    ]

    IMPACT_KW_PAYMENT = ["60%", "503", "payment failure", "payment API"]
    IMPACT_KW_REFUND = ["refund", "unavailable", "fully unavailable"]
    IMPACT_KW_WEBHOOK = [
        "webhook", "450,000", "450K", "backlog", "queue depth",
    ]

    RECOVERY_KW_ETA = ["22:30", "8 hours", "22:30 UTC"]
    RECOVERY_KW_ROLLBACK = ["rollback", "Rollback", "rolling back"]
    RECOVERY_KW_PARTIAL = ["75%", "partial recovery", "18:00", "partially"]

    ALT_KW_ASIAPAY = ["AsiaPay", "asiapay"]
    ALT_KW_COMPAT = [
        "compatible", "compatibility", "API compatible",
        "drop-in", "30 minutes", "seamless",
    ]
    ALT_KW_DIFF = ["merchant_ref", "merchant_reference"]

    WORKAROUND_KW_QUEUE = [
        "queue", "retry", "exponential backoff",
        "idempotency", "idempotent",
    ]
    WORKAROUND_KW_USWEST = [
        "us-west", "US-West", "us-west.api.cloudpay.com",
    ]

    COMPLIANCE_KW_PCI = ["PCI", "PCI DSS"]
    COMPLIANCE_KW_72H = ["72 hours", "72-hour"]
    COMPLIANCE_KW_NOTIFY = ["notification", "notify", "report", "acquiring bank"]

    FINANCIAL_KW_AMOUNT = [
        "$35,000", "$50,000", "35,000", "50,000",
    ]
    FINANCIAL_KW_LOSS = ["loss", "revenue", "cost", "losing"]
    FINANCIAL_KW_CHURN = [
        "churn", "15%", "20%", "cart abandonment", "abandonment",
    ]
