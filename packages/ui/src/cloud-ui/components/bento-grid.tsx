import { cn } from "../lib/utils";
import { GlowingEffect } from "./glowing-effect";

export const BentoGrid = ({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "mx-auto grid max-w-7xl grid-cols-1 gap-4 md:auto-rows-[18rem] md:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
};

export const BentoGridItem = ({
  className,
  title,
  description,
  header,
  icon,
}: {
  className?: string;
  title?: string | React.ReactNode;
  description?: string | React.ReactNode;
  header?: React.ReactNode;
  icon?: React.ReactNode;
}) => {
  return (
    <div
      className={cn(
        "group/bento shadow-input row-span-1 relative rounded-[0.75rem] p-[2px]",
        className,
      )}
    >
      {/* Glowing Effect */}
      <GlowingEffect
        blur={0}
        borderWidth={2}
        spread={120}
        glow={false}
        disabled={false}
        proximity={64}
        inactiveZone={0.01}
      />

      {/* Card Content - border radius slightly smaller to fit inside the outer container */}
      <div className="relative flex flex-col justify-between space-y-4 rounded-[0.625rem] border border-neutral-200 bg-white p-4 h-full transition duration-200 hover:shadow-xl dark:border-white/[0.2] dark:bg-black dark:shadow-none">
        {header}
        <div className="transition duration-200 group-hover/bento:translate-x-2">
          {icon}
          <div className="mt-2 mb-2 font-sans font-bold text-neutral-600 dark:text-neutral-200">
            {title}
          </div>
          <div className="font-sans text-xs font-normal text-neutral-600 dark:text-neutral-300">
            {description}
          </div>
        </div>
      </div>
    </div>
  );
};
