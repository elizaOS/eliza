/**
 * Hero section: heading and subtitle only.
 */

export function HeroChatInput() {
  return (
    <div className="w-full max-w-3xl mx-auto px-4">
      <div className="text-center">
        <h1
          className="text-3xl sm:text-5xl md:text-6xl font-bold text-white leading-tight"
          style={{ fontFamily: "var(--font-inter)" }}
        >
          Build something real
        </h1>
        <p className="text-lg sm:text-xl md:text-2xl text-white/70 mt-2">
          Create apps and agents by chatting with AI
        </p>
      </div>
    </div>
  );
}
