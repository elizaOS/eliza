/**
 * Gradient and noise background for the landing page.
 */

export function LandingBackground() {
  return (
    <div
      className="fixed inset-0 z-10"
      style={{
        backgroundColor: "hsla(167,0%,0%,1)",
        backgroundImage: `
          radial-gradient(at 72% 68%, hsla(6,56%,26%,1) 0px, transparent 50%),
          radial-gradient(at 50% 48%, hsla(10,60%,43%,0.7) 0px, transparent 50%),
          radial-gradient(at 98% 99%, hsla(19,48%,57%,1) 0px, transparent 50%),
          radial-gradient(at 14% 4%, hsla(14,90%,42%,1) 0px, transparent 50%),
          radial-gradient(at 34% 34%, hsla(15,72%,53%,1) 0px, transparent 50%)
        `,
      }}
    >
      <div
        style={{
          mixBlendMode: "overlay",
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
          opacity: 1,
        }}
        className="pointer-events-none absolute inset-0 invert z-10"
        aria-hidden
      />
    </div>
  );
}
