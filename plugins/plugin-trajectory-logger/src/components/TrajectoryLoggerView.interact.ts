// View-bundle `interact` capability handler, split out of TrajectoryLoggerView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./trajectory-logger-view-bundle.ts.
import { fetchTrajectoryDetail, fetchTrajectoryList } from "../api-client";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "list-trajectories" || capability === "refresh") {
    return fetchTrajectoryList({
      limit: typeof params?.limit === "number" ? params.limit : 10,
    });
  }

  if (capability === "open-latest") {
    const list = await fetchTrajectoryList({ limit: 1 });
    const latest = list.trajectories[0];
    return latest ? fetchTrajectoryDetail(latest.id) : null;
  }

  if (capability === "filter-phase") {
    const requestedPhase =
      typeof params?.phase === "string" ? params.phase.toUpperCase() : "HANDLE";
    const list = await fetchTrajectoryList({ limit: 10 });
    const details = await Promise.all(
      list.trajectories
        .slice(0, 5)
        .map((trajectory) => fetchTrajectoryDetail(trajectory.id)),
    );
    return details.map((detail) => ({
      id: detail.trajectory.id,
      status: detail.trajectory.status,
      phase: requestedPhase,
      llmCalls: detail.llmCalls.filter((call) =>
        [call.purpose, call.stepType, call.actionType]
          .filter(Boolean)
          .some((value) => value.toUpperCase().includes(requestedPhase)),
      ).length,
      toolEvents: detail.toolEvents?.length ?? 0,
      evaluationEvents: detail.evaluationEvents?.length ?? 0,
    }));
  }

  throw new Error(`Trajectory Logger TUI does not support "${capability}".`);
}
