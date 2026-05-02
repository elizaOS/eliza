/**
 * Apps skeleton loading using the shared ListSkeleton component.
 */
import { ListSkeleton } from "./list-skeleton";

export function AppsSkeleton() {
  return <ListSkeleton rows={3} variant="card" />;
}
