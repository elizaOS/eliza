from datetime import datetime

from elizaos_plugin_linear.providers.base import Provider, ProviderResult, RuntimeProtocol
from elizaos_plugin_linear.services.linear import LinearService


async def get_activity(
    runtime: RuntimeProtocol,
    _message: object,
    _state: object,
) -> ProviderResult:
    try:
        linear_service: LinearService = runtime.get_service("linear")
        if not linear_service:
            return ProviderResult(text="Linear service is not available")

        activity = linear_service.get_activity_log(10)

        if not activity:
            return ProviderResult(text="No recent Linear activity")

        activity_list = []
        for item in activity:
            status = "✓" if item.success else "✗"
            try:
                time_str = datetime.fromisoformat(item.timestamp.replace("Z", "")).strftime("%H:%M")
            except Exception:
                time_str = "?"

            activity_list.append(
                f"{status} {time_str}: {item.action} {item.resource_type} {item.resource_id}"
            )

        text = "Recent Linear Activity:\n" + "\n".join(activity_list)

        return ProviderResult(
            text=text,
            data={
                "activity": [
                    {
                        "id": item.id,
                        "action": item.action,
                        "resource_type": item.resource_type,
                        "success": item.success,
                    }
                    for item in activity[:10]
                ]
            },
        )
    except Exception:
        return ProviderResult(text="Error retrieving Linear activity")


linear_activity_provider = Provider(
    name="LINEAR_ACTIVITY",
    description="Provides context about recent Linear activity",
    get=get_activity,
)
