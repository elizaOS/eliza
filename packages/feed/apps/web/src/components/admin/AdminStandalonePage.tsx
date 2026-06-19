import { cn } from "@feed/shared";
import type { ReactNode } from "react";
import { PageContainer } from "@/components/shared/PageContainer";

interface AdminStandalonePageProps {
  children: ReactNode;
  className?: string;
}

/**
 * Shared full-width frame for standalone admin routes outside the main
 * tabbed /admin dashboard.
 */
export function AdminStandalonePage({
  children,
  className,
}: AdminStandalonePageProps) {
  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div className={cn("w-full px-4 py-6 md:px-6 md:py-8", className)}>
        {children}
      </div>
    </PageContainer>
  );
}
