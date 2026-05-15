import type {
  BackgroundHandle,
  BackgroundModule,
  BackgroundState,
} from "./types";
import { SKY_BACKGROUND_COLOR } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

interface CloudSpec {
  top: number;
  duration: number;
  delay: number;
  opacity: number;
  scale: number;
  slow: boolean;
}

const CLOUD_SPECS: readonly CloudSpec[] = [
  { top: 12, duration: 220, delay: 0, opacity: 0.86, scale: 1.0, slow: false },
  {
    top: 38,
    duration: 280,
    delay: -90,
    opacity: 0.72,
    scale: 1.18,
    slow: true,
  },
  {
    top: 64,
    duration: 340,
    delay: -180,
    opacity: 0.62,
    scale: 1.32,
    slow: true,
  },
];

function injectStyles(target: HTMLElement): HTMLStyleElement {
  const style = document.createElement("style");
  style.dataset.elizaBackground = "slow-clouds";
  style.textContent = `
    @keyframes eliza-cloud-drift-soft {
      from { transform: translate3d(-620px, 0, 0) scale(var(--scale, 1)); }
      to { transform: translate3d(720px, 0, 0) scale(var(--scale, 1)); }
    }
    @keyframes eliza-cloud-drift-slow {
      from { transform: translate3d(-680px, 0, 0) scale(var(--scale, 1)); }
      to { transform: translate3d(760px, 0, 0) scale(var(--scale, 1)); }
    }
    @keyframes eliza-cloud-breathe {
      from { transform: scale(1); }
      50% { transform: scale(1.035); }
      to { transform: scale(1); }
    }
    [data-eliza-bg="slow-clouds"] {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(0, 123, 226, 0.74) 0%, rgba(9, 145, 237, 0.62) 48%, rgba(42, 171, 246, 0.5) 100%),
        linear-gradient(180deg, #0377df 0%, #139eed 48%, #5fcaff 100%);
      background-blend-mode: soft-light, normal;
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud-filter {
      position: absolute;
      width: 0;
      height: 0;
    }
    [data-eliza-bg="slow-clouds"] .eliza-clouds {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud {
      position: absolute;
      top: var(--top);
      left: -72%;
      width: 112px;
      height: 112px;
      opacity: var(--opacity, 0.8);
      animation: eliza-cloud-drift-soft var(--duration, 220s) linear infinite;
      animation-delay: var(--delay, 0s);
      transform: translate3d(-620px, 0, 0) scale(var(--scale, 1));
      will-change: transform;
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud.is-slow {
      animation-name: eliza-cloud-drift-slow;
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud-part {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      transform: translate3d(-300px, -300px, 0);
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud-part.back {
      filter: url("#eliza-cloud-filter-back");
      box-shadow:
        300px 300px 32px -24px rgba(255, 255, 255, 0.72),
        342px 286px 42px -30px rgba(255, 255, 255, 0.52),
        254px 312px 36px -30px rgba(255, 255, 255, 0.44);
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud-part.mid {
      filter: url("#eliza-cloud-filter-mid");
      box-shadow:
        300px 300px 30px -22px rgba(255, 255, 255, 0.9),
        355px 303px 34px -28px rgba(255, 255, 255, 0.66),
        245px 294px 38px -30px rgba(255, 255, 255, 0.58);
    }
    [data-eliza-bg="slow-clouds"] .eliza-cloud-part.front {
      filter: url("#eliza-cloud-filter-front");
      box-shadow:
        300px 300px 26px -20px rgba(255, 255, 255, 0.96),
        330px 326px 31px -27px rgba(255, 255, 255, 0.7),
        272px 278px 28px -26px rgba(255, 255, 255, 0.66);
    }
    [data-eliza-bg="slow-clouds"][data-reduced-motion="true"] .eliza-cloud {
      animation: none;
      transform: translate3d(0, 0, 0) scale(var(--scale, 1));
    }
  `;
  target.appendChild(style);
  return style;
}

function buildFilterSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "eliza-cloud-filter");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const filterDefs: Array<{
    id: string;
    baseFrequency: string;
    octaves: string;
    seed: string;
    scale: string;
    blur: string;
  }> = [
    {
      id: "eliza-cloud-filter-back",
      baseFrequency: "0.011 0.019",
      octaves: "3",
      seed: "7",
      scale: "50",
      blur: "1.1",
    },
    {
      id: "eliza-cloud-filter-mid",
      baseFrequency: "0.014 0.022",
      octaves: "4",
      seed: "11",
      scale: "36",
      blur: "0.8",
    },
    {
      id: "eliza-cloud-filter-front",
      baseFrequency: "0.018 0.028",
      octaves: "4",
      seed: "17",
      scale: "24",
      blur: "0.35",
    },
  ];

  for (const def of filterDefs) {
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", def.id);
    filter.setAttribute("x", "-50%");
    filter.setAttribute("y", "-50%");
    filter.setAttribute("width", "200%");
    filter.setAttribute("height", "200%");

    const turbulence = document.createElementNS(SVG_NS, "feTurbulence");
    turbulence.setAttribute("type", "fractalNoise");
    turbulence.setAttribute("baseFrequency", def.baseFrequency);
    turbulence.setAttribute("numOctaves", def.octaves);
    turbulence.setAttribute("seed", def.seed);
    turbulence.setAttribute("result", "noise");
    filter.appendChild(turbulence);

    const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
    displace.setAttribute("in", "SourceGraphic");
    displace.setAttribute("in2", "noise");
    displace.setAttribute("scale", def.scale);
    filter.appendChild(displace);

    const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
    blur.setAttribute("stdDeviation", def.blur);
    filter.appendChild(blur);

    svg.appendChild(filter);
  }

  return svg;
}

function buildCloud(spec: CloudSpec): HTMLDivElement {
  const cloud = document.createElement("div");
  cloud.className = `eliza-cloud${spec.slow ? " is-slow" : ""}`;
  cloud.style.setProperty("--top", `${spec.top}%`);
  cloud.style.setProperty("--duration", `${spec.duration}s`);
  cloud.style.setProperty("--delay", `${spec.delay}s`);
  cloud.style.setProperty("--opacity", String(spec.opacity));
  cloud.style.setProperty("--scale", String(spec.scale));

  for (const part of ["back", "mid", "front"] as const) {
    const partEl = document.createElement("div");
    partEl.className = `eliza-cloud-part ${part}`;
    cloud.appendChild(partEl);
  }
  return cloud;
}

export function createSlowCloudsBackground(): BackgroundModule {
  return {
    id: "slow-clouds",
    kind: "svg-filtered-clouds",
    fpsBudget: 3,
    mount(target: HTMLElement): BackgroundHandle {
      target.dataset.elizaBg = "slow-clouds";
      target.style.backgroundColor = SKY_BACKGROUND_COLOR;

      const style = injectStyles(target);
      const svg = buildFilterSvg();
      target.appendChild(svg);

      const cloudsRoot = document.createElement("div");
      cloudsRoot.className = "eliza-clouds";
      for (const spec of CLOUD_SPECS) {
        cloudsRoot.appendChild(buildCloud(spec));
      }
      target.appendChild(cloudsRoot);

      const setReducedMotion = (reduced: boolean): void => {
        target.dataset.reducedMotion = reduced ? "true" : "false";
      };
      setReducedMotion(false);

      return {
        update(state: Partial<BackgroundState>): void {
          if (typeof state.reducedMotion === "boolean") {
            setReducedMotion(state.reducedMotion);
          }
        },
        unmount(): void {
          cloudsRoot.remove();
          svg.remove();
          style.remove();
          delete target.dataset.elizaBg;
          delete target.dataset.reducedMotion;
          target.style.backgroundColor = "";
        },
      };
    },
  };
}
