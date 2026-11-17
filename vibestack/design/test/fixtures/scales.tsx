export const Scales = () => (
  <div>{["z-overlay", "z-10", "z-auto", "text-body", "text-display/snug", "font-strong", "font-mono", "leading-snug", "leading-6", "tracking-wide", "outline-focus", "outline-offset-focus"].map((name) => <i key={name} className={name} />)}
    <p className="text-[13px]">a</p>
    <p className="text-sm">b</p>
    <p className="font-[650]">c</p>
    <p className="font-bold">d</p>
    <p className="leading-[1.6]">e</p>
    <p className="leading-none">f</p>
    <p className="leading-7">g</p>
    <p className="tracking-[0.08em]">h</p>
    <p className="tracking-tight">i</p>
    <p className="z-[60]">j</p>
    <p className="z-50">k</p>
    <p className="md:-z-20">l</p>
  </div>
)
