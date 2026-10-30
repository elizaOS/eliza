/** Trusted copy only: caller must prebind the target to its actual attempt. */
import { transferBoundOperationDenial, type BoundRequestOperationAttempt } from "../actions/task-extraction-context";

export function copyBoundOperationDenial<T extends object>(source: object, target: T, expectedAttempt: BoundRequestOperationAttempt | undefined): T {
  if (expectedAttempt) transferBoundOperationDenial(source, target, expectedAttempt);
  return target;
}
