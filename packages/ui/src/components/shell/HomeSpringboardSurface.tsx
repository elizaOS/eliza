import * as React from "react";
import { cn } from "../../lib/utils";
import {
  HOME_SPRINGBOARD_NAV_EVENT,
  type HomeSpringboardNavigationDetail,
  type HomeSpringboardPage,
} from "./home-springboard-events";

const HOME_TO_SPRINGBOARD_THRESHOLD = 72;
const HOME_TO_SPRINGBOARD_ANGLE_RATIO = 1.25;

interface FlickState {
  startX: number;
  startY: number;
  tracking: boolean;
  moved: boolean;
}

export interface HomeSpringboardSurfaceProps {
  home: React.ReactNode;
  springboard: React.ReactElement<{ onNavigateHomeFromEdge?: () => void }>;
  initialPage?: HomeSpringboardPage;
  className?: string;
}

export function HomeSpringboardSurface({
  home,
  springboard,
  initialPage = "home",
  className,
}: HomeSpringboardSurfaceProps): React.JSX.Element {
  const [page, setPage] = React.useState<HomeSpringboardPage>(initialPage);
  const flickRef = React.useRef<FlickState>({
    startX: 0,
    startY: 0,
    tracking: false,
    moved: false,
  });
  const suppressNextClickRef = React.useRef(false);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigation = (event: Event) => {
      const detail = (event as CustomEvent<HomeSpringboardNavigationDetail>)
        .detail;
      setPage(detail?.page ?? "home");
    };
    window.addEventListener(HOME_SPRINGBOARD_NAV_EVENT, handleNavigation);
    return () =>
      window.removeEventListener(HOME_SPRINGBOARD_NAV_EVENT, handleNavigation);
  }, []);

  const openHome = React.useCallback(() => setPage("home"), []);
  const openSpringboard = React.useCallback(() => setPage("springboard"), []);

  const handleHomePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary) return;
      flickRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        tracking: true,
        moved: false,
      };
    },
    [],
  );

  const handleHomePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = flickRef.current;
      if (!state.tracking) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (
        dx < -HOME_TO_SPRINGBOARD_THRESHOLD &&
        Math.abs(dx) > Math.abs(dy) * HOME_TO_SPRINGBOARD_ANGLE_RATIO
      ) {
        state.moved = true;
      }
    },
    [],
  );

  const handleHomePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = flickRef.current;
      if (!state.tracking) return;
      state.tracking = false;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      const shouldOpenSpringboard =
        dx < -HOME_TO_SPRINGBOARD_THRESHOLD &&
        Math.abs(dx) > Math.abs(dy) * HOME_TO_SPRINGBOARD_ANGLE_RATIO;
      if (!shouldOpenSpringboard) return;
      suppressNextClickRef.current = true;
      openSpringboard();
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    },
    [openSpringboard],
  );

  const handleHomePointerCancel = React.useCallback(() => {
    flickRef.current.tracking = false;
  }, []);

  const handleHomeClickCapture = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  const railStyle = React.useMemo<React.CSSProperties>(
    () => ({
      transform:
        page === "springboard" ? "translate3d(-50%,0,0)" : "translate3d(0,0,0)",
    }),
    [page],
  );

  return (
    <section
      data-testid="home-springboard-surface"
      data-page={page}
      className={cn("absolute inset-0 z-[1] overflow-hidden", className)}
    >
      <div
        data-testid="home-springboard-rail"
        className={cn(
          "absolute inset-0 flex w-[200%] will-change-transform",
          "transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        )}
        style={railStyle}
      >
        <div
          data-testid="home-springboard-home-page"
          aria-hidden={page !== "home"}
          className="relative h-full w-1/2 shrink-0"
          onPointerDown={handleHomePointerDown}
          onPointerMove={handleHomePointerMove}
          onPointerUp={handleHomePointerUp}
          onPointerCancel={handleHomePointerCancel}
          onClickCapture={handleHomeClickCapture}
        >
          {home}
        </div>
        <div
          data-testid="home-springboard-springboard-page"
          aria-hidden={page !== "springboard"}
          className="relative h-full w-1/2 shrink-0"
        >
          {React.cloneElement(springboard, {
            onNavigateHomeFromEdge: openHome,
          })}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[calc(var(--safe-area-bottom,0px)+5.9rem)] z-[2] flex justify-center gap-1.5"
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-colors",
            page === "home" ? "bg-white/70" : "bg-white/25",
          )}
        />
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full transition-colors",
            page === "springboard" ? "bg-white/70" : "bg-white/25",
          )}
        />
      </div>
    </section>
  );
}
