/**
 * View-bundle capability handler for the trajectory logger surface.
 * It stays separate from the React component file so Fast Refresh sees
 * component-only exports while the built view bundle still exposes `interact`.
 */

import { fetchTrajectoryDetail, fetchTrajectoryList } from "../api-client";
import { phaseOf } from "../phases";

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
    const limit = typeof params?.limit === "number" ? params.limit : 10;
    const list = await fetchTrajectoryList({ limit });
    // Summarize every listed trajectory: a dropped row is indistinguishable
    // from a trajectory that does not exist.
    const details = await Promise.all(
      list.trajectories.map((trajectory) =>
        fetchTrajectoryDetail(trajectory.id),
      ),
    );
    return details.map((detail) => ({
      id: detail.trajectory.id,
      status: detail.trajectory.status,
      phase: requestedPhase,
      llmCalls: detail.llmCalls.filter(
        (call) => phaseOf(call) === requestedPhase,
      ).length,
      toolEvents:
        requestedPhase === "ACTION" ? (detail.toolEvents?.length ?? 0) : 0,
      evaluationEvents:
        requestedPhase === "EVALUATE"
          ? (detail.evaluationEvents?.length ?? 0)
          : 0,
    }));
  }

  throw new Error(`Trajectory Logger TUI does not support "${capability}".`);
}
