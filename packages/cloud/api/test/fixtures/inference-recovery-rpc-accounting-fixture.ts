/** RPC accounting fixture; does not claim PostgreSQL settlement coverage. */
import { WorkerEntrypoint } from "cloudflare:workers";
export class RecoveryFixture extends WorkerEntrypoint {
  async recover(
    _context: unknown,
    cost: number,
    options: {
      inferenceBalanceFence: {
        lowerCommittedBalance(balance: number, revision: string): Promise<void>;
        publishAuthoritativeBalance(
          balance: number,
          revision: string,
        ): Promise<void>;
      };
    },
  ) {
    await options.inferenceBalanceFence.lowerCommittedBalance(9, "2");
    await options.inferenceBalanceFence.publishAuthoritativeBalance(9, "2");
    return {
      balanceUsd: 9,
      balanceRevision: "2",
      collectedUsd: cost,
      gateConsumedUsd: cost,
    };
  }
}
export default {
  fetch() {
    return new Response("private", { status: 404 });
  },
};
