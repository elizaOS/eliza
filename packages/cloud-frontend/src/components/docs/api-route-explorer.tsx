import { ApiRouteExplorer as BaseApiRouteExplorer } from "@elizaos/ui";
import type {
  DiscoveredApiRouteDto,
  HttpMethod,
} from "@elizaos/ui/cloud-ui/types/cloud-api";
import { ELIZA_CLOUD_PUBLIC_ENDPOINTS } from "../../../../cloud-sdk/src/public-routes";

const API_ROUTES: DiscoveredApiRouteDto[] = Object.values(
  ELIZA_CLOUD_PUBLIC_ENDPOINTS,
).map((endpoint) => ({
  path: endpoint.path,
  methods: [endpoint.method as HttpMethod],
  filePath: endpoint.file,
  meta: {
    id: `${endpoint.method} ${endpoint.path}`,
    name: endpoint.methodName,
    description: `${endpoint.method} ${endpoint.path}`,
    category: endpoint.path.split("/").filter(Boolean)[2] ?? "root",
    requiresAuth: true,
  },
}));

export function ApiRouteExplorer() {
  return <BaseApiRouteExplorer routes={API_ROUTES} />;
}
