from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    text: str
    data: dict | None = None


class PluginCreationStatusProvider:
    name = "plugin_creation_status"
    description = "Provides status of active plugin creation jobs"

    async def get(self, context: ProviderContext) -> ProviderResult:
        jobs = context.state.get("jobs", [])

        active_jobs = [j for j in jobs if j.get("status") in ("running", "pending")]

        if not active_jobs:
            return ProviderResult(
                text="No active plugin creation jobs",
            )

        job = active_jobs[0]
        spec = job.get("specification", {})
        name = spec.get("name", "unknown")
        status = job.get("status", "unknown")
        phase = job.get("currentPhase", "unknown")
        progress = job.get("progress", 0)

        return ProviderResult(
            text=f"Active plugin creation: {name} - Status: {status}, Phase: {phase}, Progress: {progress:.0f}%",
            data={
                "pluginName": name,
                "status": status,
                "phase": phase,
                "progress": progress,
            },
        )


plugin_creation_status_provider = PluginCreationStatusProvider()
