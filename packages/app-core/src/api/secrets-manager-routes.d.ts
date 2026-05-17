import type http from "node:http";
import { type BackendId, type SecretsManager } from "@elizaos/vault";
/** Test hook: drop the cached manager. Production code must not call this. */
export declare function _resetSecretsManagerForTesting(): void;
/** Test hook: inject a manager built around a test vault + stub exec. */
export declare function _setSecretsManagerForTesting(next: SecretsManager | null): void;
export declare function handleSecretsManagerRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, method: string): Promise<boolean>;
export type { BackendId };
//# sourceMappingURL=secrets-manager-routes.d.ts.map