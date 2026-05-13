'use client';

export default function ProductSkeleton() {
  return (
    <div data-testid="product-skeleton" className="bg-[var(--card-bg)] rounded-lg p-4">
      <div data-testid="skeleton-image" className="w-full h-48 bg-gray-300 animate-pulse" />
      <div data-testid="skeleton-title" className="mt-3 h-4 w-3/4 bg-gray-300 animate-pulse" />
    </div>
  );
}
