import { useQuery } from "@tanstack/react-query";

export function usePlugins() {
	return useQuery({
		queryKey: ["plugins"],
		queryFn: async () => {
			const response = await fetch(
				"https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json",
			);
			return response.json();
		},
	});
}
