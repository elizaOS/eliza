import { useQuery } from "@tanstack/react-query";
import type { CustomQueryResult } from "../types";
import { Queries } from "./queries";
import { ROUTES } from "../routes";

export type Agent = {
    id: string;
    name: string;
};

export const useGetAgentsQuery = (): CustomQueryResult<Agent[] | undefined> => {
    return useQuery({
        queryKey: [Queries.AGENTS],
        queryFn: async () => {
            const res = await fetch(ROUTES.getAgents());
            const data = await res.json();
            return data.agents as Agent[];
        },
        retry: (failureCount) => failureCount < 3,
        staleTime: 5 * 60 * 1000, // 5 minutes
        refetchOnWindowFocus: false,
    });
};
