import os


# Default TTL minutes for instance auto-termination (cloud-side scheduler)
# Can be overridden via environment variable DEFAULT_TTL_MINUTES
DEFAULT_TTL_MINUTES: int = int(os.getenv("DEFAULT_TTL_MINUTES", "180"))

# Master switch for TTL feature
ENABLE_TTL: bool = os.getenv("ENABLE_TTL", "true").lower() == "true"

# EventBridge Scheduler role ARN for scheduling EC2 termination
AWS_SCHEDULER_ROLE_ARN: str = os.getenv("AWS_SCHEDULER_ROLE_ARN", "").strip()


def compute_ttl_seconds(ttl_minutes: int) -> int:
    try:
        return max(0, int(ttl_minutes) * 60)
    except Exception:
        return 0


