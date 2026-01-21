/**
 * Agents Loading Component
 *
 * @description Loading skeleton for the agents page, displaying skeleton loaders
 * for the header, filter tabs, and agent cards grid.
 *
 * @returns {JSX.Element} Agents loading skeleton
 */
import { Card } from "@/components/ui/card";

export default function AgentsLoading() {
  return (
    <div className="container mx-auto max-w-7xl p-6">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <div className="mb-2 h-8 w-48 animate-pulse rounded bg-gray-700" />
          <div className="h-4 w-96 animate-pulse rounded bg-gray-700" />
        </div>
        <div className="h-10 w-32 animate-pulse rounded bg-gray-700" />
      </div>

      <div className="mb-6 flex gap-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 w-16 animate-pulse rounded bg-gray-700" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="animate-pulse p-6">
            <div className="mb-4 flex items-center gap-4">
              <div className="h-12 w-12 rounded-full bg-gray-700" />
              <div className="flex-1">
                <div className="mb-2 h-4 w-24 rounded bg-gray-700" />
                <div className="h-3 w-16 rounded bg-gray-700" />
              </div>
            </div>
            <div className="mb-4 space-y-2">
              <div className="h-3 rounded bg-gray-700" />
              <div className="h-3 w-3/4 rounded bg-gray-700" />
            </div>
            <div className="grid grid-cols-2 gap-4 border-border border-t pt-4">
              <div className="h-12 rounded bg-gray-700" />
              <div className="h-12 rounded bg-gray-700" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
